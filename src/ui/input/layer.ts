/**
 * The input layer (Proposal 0014, decisions 361–366): gamepads and joysticks as named
 * actions and tuned axes. The flight inputs, the displays and the menus subscribe here;
 * none of them reads a device.
 *
 * - **Actions.** A device's code events resolve through the active profile: the aircraft
 *   class's table (`fixed` or `rotary`, set by whichever flight input is enabled) and the
 *   global table (menus, the campaign). Subscribers get `(action, down)`.
 * - **Axes.** `axis(id)` is the tuned value of an analog control, the largest among the
 *   connected devices; the left stick's pair goes through the cross-talk guard.
 * - **Merging.** Gamepads and joysticks each resolve through their own profile and their
 *   actions add up: an action is held while any device holds it.
 */
import { tuneAxis, tuneStick } from './axis';
import { ActionResolver } from './bindings';
import { GamepadSource, gamepads } from './gamepad';
import type { DeviceKind, PadEvent } from './gamepad';
import { profiles } from './profiles';
import type { AircraftClass, AxisId, AxisMode, PadProfile, ProfileStore } from './profiles';

export type ActionListener = (action: string, down: boolean) => void;

const KINDS: readonly DeviceKind[] = ['gamepad', 'joystick'];

export class InputLayer {
  private cls: AircraftClass = 'fixed';
  private readonly aircraft = new Map<DeviceKind, ActionResolver>();
  private readonly global = new Map<DeviceKind, ActionResolver>();
  private readonly listeners = new Set<ActionListener>();
  private readonly globalListeners = new Set<ActionListener>();
  /** Raw listeners return true when they consumed a press (a menu acted on it). */
  private readonly rawListeners = new Set<(e: PadEvent) => boolean | void>();
  /** While set, every device event goes to it alone (press-to-bind). */
  capture: ((e: PadEvent) => void) | null = null;

  constructor(
    readonly source: GamepadSource = gamepads(),
    readonly store: ProfileStore = profiles(),
  ) {
    for (const k of KINDS) {
      this.aircraft.set(k, new ActionResolver());
      this.global.set(k, new ActionResolver());
    }
    this.rebuild();
    store.onChange(() => this.rebuild());
    source.on((e) => this.event(e));
  }

  /** The class whose profile resolves the aircraft's actions. */
  get aircraftClass(): AircraftClass {
    return this.cls;
  }

  set aircraftClass(c: AircraftClass) {
    if (c === this.cls) return;
    // Whatever the old class's table held ends: no action is left held across a switch.
    for (const k of KINDS)
      for (const a of this.aircraft.get(k)!.clear()) this.emit(this.listeners, a, false);
    this.cls = c;
    this.rebuild();
  }

  /** Subscribes to the aircraft class's actions; returns the unsubscribe. */
  onAction(fn: ActionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribes to the global actions (menus, campaign). */
  onGlobal(fn: ActionListener): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  /**
   * Subscribes to the devices' raw events (menu navigation, the input monitor). A listener
   * that returns true consumes a press: no action starts from it, so the ✕ that flies from
   * the start screen does not also raise the gear, and its release ends nothing.
   */
  onRaw(fn: (e: PadEvent) => boolean | void): () => void {
    this.rawListeners.add(fn);
    return () => this.rawListeners.delete(fn);
  }

  /** Whether an aircraft action is held on any device. */
  held(action: string): boolean {
    for (const r of this.aircraft.values()) if (r.held(action)) return true;
    return false;
  }

  /** Whether any device is connected. */
  get connected(): boolean {
    return this.source.anyConnected;
  }

  /** The active profile of a device kind. */
  profile(kind: DeviceKind): PadProfile {
    return this.store.pad(kind, this.cls);
  }

  /**
   * The tuned value of an analog control: the largest among the connected devices of every
   * kind whose profile binds it (0 when none does).
   */
  axis(id: AxisId): number {
    let best = 0;
    for (const k of KINDS) {
      if (!this.source.has(k)) continue;
      const v = this.tuned(k, id);
      if (Math.abs(v) > Math.abs(best)) best = v;
    }
    return best;
  }

  /** The mode of an analog control on the device that drives it now (`rate` by default). */
  axisMode(id: AxisId): AxisMode {
    let mode: AxisMode = 'rate';
    let best = -1;
    for (const k of KINDS) {
      if (!this.source.has(k)) continue;
      const s = this.profile(k).axes[id];
      if (!s || s.axis < 0) continue;
      const v = Math.abs(this.tuned(k, id));
      if (v > best) {
        best = v;
        mode = s.mode ?? 'rate';
      }
    }
    return mode;
  }

  /** Whether a device that is connected binds `id` to an axis. */
  hasAxis(id: AxisId): boolean {
    for (const k of KINDS) {
      if (!this.source.has(k)) continue;
      const s = this.profile(k).axes[id];
      if (s && s.axis >= 0) return true;
    }
    return false;
  }

  private tuned(kind: DeviceKind, id: AxisId): number {
    const p = this.profile(kind);
    const s = p.axes[id];
    if (!s || s.axis < 0) return 0;
    const raw = this.source.axis(s.axis, kind);
    // The left stick's pair: the yaw or pedals and the throttle or collective guard each other.
    const pair = PAIRS[id];
    const o = pair ? p.axes[pair] : undefined;
    if (
      o &&
      o.axis >= 0 &&
      p.options.crossGuard > 0 &&
      (s.mode ?? 'rate') === 'rate' &&
      (o.mode ?? 'rate') === 'rate'
    ) {
      const other = this.source.axis(o.axis, kind);
      return tuneStick(raw, other, s, o, p.options.crossGuard).x;
    }
    return tuneAxis(raw, s);
  }

  private rebuild(): void {
    for (const k of KINDS) {
      this.aircraft.get(k)!.setTable(this.store.pad(k, this.cls).buttons);
      this.global.get(k)!.setTable(this.store.global(k));
    }
  }

  private event(e: PadEvent): void {
    if (this.capture) {
      this.capture(e);
      return;
    }
    let consumed = false;
    for (const fn of [...this.rawListeners]) if (fn(e) === true) consumed = true;
    if (e.type !== 'press' && e.type !== 'release') return;
    if (consumed && e.type === 'press') return;
    const down = e.type === 'press';
    const air = this.aircraft.get(e.kind)!;
    const glob = this.global.get(e.kind)!;
    for (const a of down ? air.press(e.code) : air.release(e.code))
      this.emit(this.listeners, a, down);
    for (const a of down ? glob.press(e.code) : glob.release(e.code))
      this.emit(this.globalListeners, a, down);
  }

  private emit(set: Set<ActionListener>, a: string, down: boolean): void {
    for (const fn of [...set]) fn(a, down);
  }
}

/** The left stick's pairs for the cross-talk guard. */
const PAIRS: Partial<Record<AxisId, AxisId>> = {
  yaw: 'throttle',
  throttle: 'yaw',
  pedals: 'collective',
  collective: 'pedals',
};

let shared: InputLayer | null = null;

/** The app's input layer. */
export function inputLayer(): InputLayer {
  return (shared ??= new InputLayer());
}

/** Replaces the shared layer (tests, tools). */
export function setInputLayer(l: InputLayer | null): void {
  shared = l;
}
