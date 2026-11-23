/**
 * Gamepads through the browser's Gamepad API (Proposal 0014, decision 364).
 *
 * - **Polling.** Browsers report gamepad state only when asked, so the source reads
 *   `navigator.getGamepads()` once per animation frame on its own `requestAnimationFrame`
 *   loop and turns changes into events, as a keyboard sends keydown and keyup: a button
 *   (`Pad7`) or a half axis (`Axis1-`) pressed or released. Tools and tests call `poll()`.
 * - **Merging.** Every connected pad counts: a code is down while any pad holds it, and an
 *   axis reads the pad deflected farthest. Pads with the standard mapping are `gamepad`s,
 *   all others (flight sticks, throttles, pedals) `joystick`s, each with its own profile.
 * - **Connecting.** Browsers hide a gamepad until one of its buttons is pressed after the
 *   page loads; the source reports a connect then, and a disconnect at any time, releasing
 *   whatever the pad held.
 * - **Rumble** through `vibrationActuator.playEffect('dual-rumble')` where the browser and
 *   the pad have it.
 */
import {
  BUTTON_PRESS,
  HALF_AXIS_PRESS,
  HALF_AXIS_RELEASE,
  axisCode,
  padCode,
  padFamily,
} from './codes';
import type { PadFamily } from './codes';

export type DeviceKind = 'gamepad' | 'joystick';

/** The parts of a `Gamepad` the source reads (tests pass plain objects). */
export interface PadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly vibrationActuator?: {
    playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
  } | null;
}

export type PadProvider = () => readonly (PadLike | null)[];

export interface PadInfo {
  index: number;
  id: string;
  kind: DeviceKind;
  family: PadFamily;
  rumble: boolean;
}

export type PadEvent =
  | { type: 'press' | 'release'; code: string; kind: DeviceKind; pad: number }
  | { type: 'connect' | 'disconnect'; info: PadInfo };

const defaultProvider: PadProvider = () => {
  try {
    return typeof navigator !== 'undefined' && navigator.getGamepads
      ? (navigator.getGamepads() as readonly (PadLike | null)[])
      : [];
  } catch {
    // A permissions policy can forbid the API.
    return [];
  }
};

interface PadRecord {
  info: PadInfo;
  pad: PadLike;
  /** Codes this pad holds down. */
  down: Set<string>;
}

export class GamepadSource {
  private readonly pads = new Map<number, PadRecord>();
  private readonly listeners = new Set<(e: PadEvent) => void>();
  private raf = 0;
  /** Seconds since the last button press or deflection, for "last used" decisions. */
  lastActivity = -Infinity;

  constructor(
    private readonly provider: PadProvider = defaultProvider,
    private readonly now: () => number = () =>
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
  ) {}

  /** Subscribes to events; returns the unsubscribe. */
  on(fn: (e: PadEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Starts polling once per animation frame (no-op without `requestAnimationFrame`). */
  start(): void {
    if (this.raf || typeof requestAnimationFrame !== 'function') return;
    const loop = () => {
      this.poll();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** The connected pads. */
  get connected(): PadInfo[] {
    return [...this.pads.values()].map((r) => r.info);
  }

  get anyConnected(): boolean {
    return this.pads.size > 0;
  }

  /** The family of the first connected gamepad, for button names. */
  get family(): PadFamily {
    for (const r of this.pads.values()) return r.info.family;
    return 'generic';
  }

  /** Reads every pad once and sends the events of what changed. */
  poll(): void {
    const seen = new Set<number>();
    for (const p of this.provider()) {
      if (!p || !p.connected) continue;
      seen.add(p.index);
      let r = this.pads.get(p.index);
      if (!r || r.info.id !== p.id) {
        if (r) this.drop(r);
        const kind: DeviceKind = p.mapping === 'standard' ? 'gamepad' : 'joystick';
        r = {
          info: {
            index: p.index,
            id: p.id,
            kind,
            family: kind === 'gamepad' ? padFamily(p.id) : 'generic',
            rumble: typeof p.vibrationActuator?.playEffect === 'function',
          },
          pad: p,
          down: new Set(),
        };
        this.pads.set(p.index, r);
        this.emit({ type: 'connect', info: r.info });
      }
      r.pad = p;
      this.scan(r);
    }
    for (const r of [...this.pads.values()]) if (!seen.has(r.info.index)) this.drop(r);
  }

  private scan(r: PadRecord): void {
    const p = r.pad;
    const next = new Set<string>();
    p.buttons.forEach((b, i) => {
      const code = padCode(i);
      // Analog triggers report `pressed` from a small value in some browsers; use the value.
      const v = b.value || (b.pressed ? 1 : 0);
      if (v >= BUTTON_PRESS || (r.down.has(code) && v >= BUTTON_PRESS * 0.6)) next.add(code);
    });
    p.axes.forEach((v, i) => {
      for (const dir of [1, -1] as const) {
        const code = axisCode(i, dir);
        const d = v * dir;
        if (d >= HALF_AXIS_PRESS || (r.down.has(code) && d >= HALF_AXIS_RELEASE)) next.add(code);
      }
    });
    for (const code of r.down)
      if (!next.has(code)) {
        r.down.delete(code);
        this.emit({ type: 'release', code, kind: r.info.kind, pad: r.info.index });
      }
    for (const code of next)
      if (!r.down.has(code)) {
        r.down.add(code);
        this.lastActivity = this.now();
        this.emit({ type: 'press', code, kind: r.info.kind, pad: r.info.index });
      }
  }

  private drop(r: PadRecord): void {
    for (const code of r.down)
      this.emit({ type: 'release', code, kind: r.info.kind, pad: r.info.index });
    r.down.clear();
    this.pads.delete(r.info.index);
    this.emit({ type: 'disconnect', info: r.info });
  }

  private emit(e: PadEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  /**
   * The raw axis `i` of the devices of `kind`: the value farthest from center among them.
   */
  axis(i: number, kind: DeviceKind): number {
    let best = 0;
    for (const r of this.pads.values()) {
      if (r.info.kind !== kind) continue;
      const v = r.pad.axes[i] ?? 0;
      if (Math.abs(v) > Math.abs(best)) best = v;
    }
    return best;
  }

  /** The analog value (0..1) of button `i` on the devices of `kind`, the largest among them. */
  button(i: number, kind: DeviceKind): number {
    let best = 0;
    for (const r of this.pads.values()) {
      if (r.info.kind !== kind) continue;
      const b = r.pad.buttons[i];
      if (b) best = Math.max(best, b.value || (b.pressed ? 1 : 0));
    }
    return best;
  }

  /** Whether any device of `kind` is connected. */
  has(kind: DeviceKind): boolean {
    for (const r of this.pads.values()) if (r.info.kind === kind) return true;
    return false;
  }

  /** Whether a device of `kind` holds `code` down. */
  isDown(code: string, kind?: DeviceKind): boolean {
    for (const r of this.pads.values())
      if ((!kind || r.info.kind === kind) && r.down.has(code)) return true;
    return false;
  }

  /**
   * Rumbles every gamepad that can: `strong` and `weak` motor magnitudes 0..1 for
   * `ms` milliseconds. Returns whether any pad took it.
   */
  rumble(strong: number, weak: number, ms: number): boolean {
    let any = false;
    for (const r of this.pads.values()) {
      const play = r.pad.vibrationActuator?.playEffect;
      if (typeof play !== 'function') continue;
      any = true;
      play
        .call(r.pad.vibrationActuator, 'dual-rumble', {
          startDelay: 0,
          duration: ms,
          strongMagnitude: Math.min(1, Math.max(0, strong)),
          weakMagnitude: Math.min(1, Math.max(0, weak)),
        })
        .catch(() => {
          /* the pad went away, or the page lost focus */
        });
    }
    return any;
  }
}

let shared: GamepadSource | null = null;

/** The app's one gamepad source, polling from the first call where a browser runs it. */
export function gamepads(): GamepadSource {
  if (!shared) {
    shared = new GamepadSource();
    shared.start();
  }
  return shared;
}

/** Replaces the shared source (tests, tools that feed synthetic pads). */
export function setGamepads(s: GamepadSource | null): void {
  shared?.stop();
  shared = s;
}
