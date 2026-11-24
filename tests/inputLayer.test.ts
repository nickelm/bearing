/**
 * The input layer (Proposal 0014): axis tuning, the cross-talk guard, the throttle as a
 * rate with its detent and snaps, chord resolution, the gamepad source's events, profiles
 * and their persistence, and the jet's and helicopter's inputs driven by a synthetic pad.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { curve, deadzone, guardedDeadzones, tuneAxis, tuneStick } from '../src/ui/input/axis';
import type { AxisTuning } from '../src/ui/input/axis';
import { ActionResolver, conflicts } from '../src/ui/input/bindings';
import { bindingName, codeKind, padFamily, parseBinding } from '../src/ui/input/codes';
import { GamepadSource } from '../src/ui/input/gamepad';
import type { PadEvent, PadLike } from '../src/ui/input/gamepad';
import { InputLayer } from '../src/ui/input/layer';
import { nextInDirection } from '../src/ui/input/menuNav';
import { padlockAngles } from '../src/ui/input/padlock';
import { buffetFromAlpha } from '../src/ui/input/rumble';
import { Vec3d } from '../src/core/vec3d';
import { defaultGamepad, ProfileStore, parseStored } from '../src/ui/input/profiles';
import { AB_HOLD, RATE, throttleRate, throttleRateState } from '../src/ui/input/throttleRate';
import { AB_GATE, MIL_DETENT } from '../src/sim/flight/controlLaws';
import { FlightInput } from '../src/ui/flight/flightInput';
import { HeloInput } from '../src/ui/flight/heloInput';
import { MouseCapture } from '../src/ui/flight/mouseCapture';

const tuning = (o: Partial<AxisTuning> = {}): AxisTuning => ({
  axis: 0,
  invert: false,
  deadzone: 0.1,
  curve: 0,
  sensitivity: 1,
  ...o,
});

describe('axis tuning', () => {
  it('scales the deadzone so the output starts from zero', () => {
    expect(deadzone(0.05, 0.1)).toBe(0);
    expect(deadzone(-0.1, 0.1)).toBe(0);
    expect(deadzone(0.55, 0.1)).toBeCloseTo(0.5);
    expect(deadzone(-1, 0.1)).toBeCloseTo(-1);
  });

  it('bends the response with expo, keeping the ends', () => {
    expect(curve(1, 0.5)).toBeCloseTo(1);
    expect(curve(-1, 1)).toBeCloseTo(-1);
    expect(curve(0.5, 0)).toBeCloseTo(0.5);
    expect(curve(0.5, 1)).toBeCloseTo(0.125);
    expect(Math.abs(curve(0.3, 0.5))).toBeLessThan(0.3);
  });

  it('inverts, then applies deadzone, curve and sensitivity, clamped', () => {
    expect(tuneAxis(0.55, tuning({ invert: true }))).toBeCloseTo(-0.5);
    expect(tuneAxis(0.55, tuning({ sensitivity: 2 }))).toBeCloseTo(1);
    expect(tuneAxis(1, tuning({ sensitivity: 2 }))).toBe(1);
    expect(tuneAxis(0.05, tuning())).toBe(0);
  });

  it('ignores sideways wobble during a firm push up, and vertical wobble during yaw', () => {
    const t = tuning({ deadzone: 0.15 });
    // Collective or throttle full up, the thumb drifting 0.3 sideways.
    expect(tuneStick(0.3, -1, t, t, 0.4).x).toBe(0);
    expect(tuneStick(0.3, -1, t, t, 0.4).y).toBeCloseTo(-1);
    // Full yaw with 0.3 vertical drift.
    expect(tuneStick(1, 0.3, t, t, 0.4).y).toBe(0);
    // A deliberate diagonal moves both.
    const d = tuneStick(0.7, -0.7, t, t, 0.4);
    expect(d.x).toBeGreaterThan(0.3);
    expect(d.y).toBeLessThan(-0.3);
    // Without the guard each axis keeps its own deadzone only.
    expect(guardedDeadzones(0.3, -1, 0.15, 0.15, 0)).toEqual({ x: 0.15, y: 0.15 });
  });
});

describe('throttle as a rate (decision 363)', () => {
  const run = (s = throttleRateState(), lever = 0, v = 0, seconds = 0, max = 1) => {
    let l = lever;
    const events: string[] = [];
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      const r = throttleRate(s, l, v, 1 / 60, max);
      l = r.lever;
      if (r.event) events.push(r.event);
    }
    return { lever: l, events, s };
  };

  it('moves while pushed and holds when let go', () => {
    const a = run(undefined, 0, 1, 1);
    expect(a.lever).toBeCloseTo(RATE, 2);
    const b = run(a.s, a.lever, 0, 2);
    expect(b.lever).toBe(a.lever);
    const c = run(b.s, b.lever, -0.5, 0.5);
    expect(c.lever).toBeCloseTo(a.lever - RATE * 0.25, 2);
  });

  it('stops at military, and passes into afterburner only after a held push', () => {
    const a = run(undefined, 0.7, 1, 0.3);
    expect(a.lever).toBe(MIL_DETENT);
    const a2 = run(a.s, a.lever, 0, 0.1);
    // A push shorter than the hold stays at military.
    const b = run(a2.s, a2.lever, 1, AB_HOLD - 0.1);
    expect(b.lever).toBe(MIL_DETENT);
    const c = run(b.s, b.lever, 0, 0.1);
    const d = run(c.s, c.lever, 1, AB_HOLD + 0.05);
    expect(d.lever).toBeGreaterThanOrEqual(AB_GATE);
    expect(d.events).toContain('afterburner');
    // A gentle push never passes the gate.
    const e = run(undefined, MIL_DETENT, 0.5, 3);
    expect(e.lever).toBe(MIL_DETENT);
    // Without an afterburner the lever ends at military.
    expect(run(undefined, MIL_DETENT, 1, 3, MIL_DETENT).lever).toBe(MIL_DETENT);
  });

  it('stops at military on the way down from afterburner until the stick is let go', () => {
    const a = run(undefined, 1, -1, 2);
    expect(a.lever).toBe(MIL_DETENT);
    const b = run(a.s, a.lever, 0, 0.1);
    const c = run(b.s, b.lever, -1, 0.5);
    expect(c.lever).toBeLessThan(MIL_DETENT);
  });

  it('snaps to military on a double tap up and to idle on a double tap down', () => {
    const s = throttleRateState();
    const tap = (lever: number, v: number) => {
      let l = run(s, lever, v, 0.1).lever;
      l = run(s, l, 0, 0.1).lever;
      return l;
    };
    let l = tap(0.2, 1);
    const r = run(s, l, 1, 0.1);
    l = run(s, r.lever, 0, 1 / 60).lever;
    expect(l).toBe(MIL_DETENT);
    l = tap(l, -1);
    const down = run(s, l, -1, 0.1);
    const end = run(s, down.lever, 0, 1 / 60);
    expect(end.lever).toBe(0);
    expect([...down.events, ...end.events]).toContain('snap-idle');
    // Two slow pushes are no double tap.
    const s2 = throttleRateState();
    let m = run(s2, 0.2, 1, 0.5).lever;
    m = run(s2, m, 0, 0.1).lever;
    m = run(s2, m, 1, 0.5).lever;
    m = run(s2, m, 0, 0.1).lever;
    expect(m).toBeLessThan(MIL_DETENT);
  });
});

describe('binding resolution', () => {
  it('names codes and parses chords', () => {
    expect(codeKind('KeyW')).toBe('key');
    expect(codeKind('Pad7')).toBe('pad');
    expect(codeKind('Axis1-')).toBe('axis');
    expect(codeKind('Mouse4')).toBe('mouse');
    expect(parseBinding('Pad4&Pad12')).toEqual({ modifier: 'Pad4', code: 'Pad12' });
    expect(bindingName('Pad4&Pad12', 'playstation')).toBe('L1 + D-pad ↑');
    expect(bindingName('Pad0', 'xbox')).toBe('A');
    expect(padFamily('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe(
      'playstation',
    );
  });

  it('fires a chord instead of the plain binding while its modifier is held', () => {
    const r = new ActionResolver({ look: ['Pad4'], mode: ['Pad12'], caution: ['Pad4&Pad12'] });
    expect(r.press('Pad12')).toEqual(['mode']);
    expect(r.release('Pad12')).toEqual(['mode']);
    expect(r.press('Pad4')).toEqual(['look']);
    expect(r.held('look')).toBe(true);
    expect(r.press('Pad12')).toEqual(['caution']);
    // The modifier let go first: the chord still ends with its own release.
    r.release('Pad4');
    expect(r.held('caution')).toBe(true);
    expect(r.release('Pad12')).toEqual(['caution']);
    expect(r.held('caution')).toBe(false);
    expect(r.isModifier('Pad4')).toBe(true);
  });

  it('reports conflicts and binds one code to two actions', () => {
    const t = { a: ['Pad0'], b: ['Pad0', 'Pad1'], c: ['Pad2'] };
    expect([...conflicts(t)]).toEqual([['Pad0', ['a', 'b']]]);
    const r = new ActionResolver(t);
    expect(r.press('Pad0').sort()).toEqual(['a', 'b']);
  });

  it('gives the default layout no plain conflicts within a class', () => {
    for (const cls of ['fixed', 'rotary'] as const)
      for (const bumpers of [false, true])
        expect([...conflicts(defaultGamepad(cls, bumpers).buttons)]).toEqual([]);
  });
});

/** A synthetic standard gamepad. */
class FakePad implements PadLike {
  id = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
  connected = true;
  mapping = 'standard';
  axes = [0, 0, 0, 0];
  buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  constructor(public index = 0) {}
  set(i: number, v: number) {
    this.buttons[i] = { pressed: v > 0.5, value: v };
  }
}

describe('the gamepad source', () => {
  it('reports connect, presses, half axes, releases and disconnect', () => {
    const pads: (FakePad | null)[] = [];
    const src = new GamepadSource(() => pads);
    const events: PadEvent[] = [];
    src.on((e) => events.push(e));
    src.poll();
    expect(events).toEqual([]);
    const p = new FakePad();
    pads.push(p);
    p.set(0, 1);
    src.poll();
    expect(events.map((e) => e.type)).toEqual(['connect', 'press']);
    expect(src.family).toBe('playstation');
    p.axes[1] = -0.8;
    src.poll();
    expect(events.at(-1)).toMatchObject({ type: 'press', code: 'Axis1-' });
    // Hysteresis: 0.4 still holds, 0.2 releases.
    p.axes[1] = -0.4;
    src.poll();
    expect(src.isDown('Axis1-')).toBe(true);
    p.axes[1] = -0.2;
    src.poll();
    expect(src.isDown('Axis1-')).toBe(false);
    pads.length = 0;
    src.poll();
    expect(events.slice(-2).map((e) => e.type)).toEqual(['release', 'disconnect']);
    expect(src.anyConnected).toBe(false);
  });

  it('merges two pads: the farther axis and either button', () => {
    const a = new FakePad(0);
    const b = new FakePad(1);
    const src = new GamepadSource(() => [a, b]);
    a.axes[2] = 0.3;
    b.axes[2] = -0.6;
    src.poll();
    expect(src.axis(2, 'gamepad')).toBe(-0.6);
    b.set(7, 1);
    src.poll();
    expect(src.isDown('Pad7')).toBe(true);
    expect(src.button(7, 'gamepad')).toBe(1);
  });

  it('rumbles the pads that can', () => {
    const play = vi.fn(() => Promise.resolve('complete'));
    const p = Object.assign(new FakePad(), { vibrationActuator: { playEffect: play } });
    const src = new GamepadSource(() => [p]);
    src.poll();
    expect(src.connected[0]!.rumble).toBe(true);
    expect(src.rumble(0.5, 0.2, 100)).toBe(true);
    expect(play).toHaveBeenCalledWith('dual-rumble', expect.objectContaining({ duration: 100 }));
  });
});

describe('profiles', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it('keeps key bindings in the registered table, saved and restored', () => {
    const storage = memory();
    const table: Record<string, string[]> = { gear: ['KeyG'], fire: ['Enter'] };
    const s = new ProfileStore(storage);
    s.registerKeys('fixed', table);
    s.setKeys('fixed', 'gear', ['KeyY', 'Mouse4']);
    expect(table.gear).toEqual(['KeyY', 'Mouse4']);
    const table2: Record<string, string[]> = { gear: ['KeyG'], fire: ['Enter'] };
    const s2 = new ProfileStore(storage);
    s2.registerKeys('fixed', table2);
    expect(table2.gear).toEqual(['KeyY', 'Mouse4']);
    expect(table2.fire).toEqual(['Enter']);
    s2.reset('keyboard');
    expect(table2.gear).toEqual(['KeyG']);
  });

  it('exports and imports, merging over the defaults, and refuses what is not a profile', () => {
    const s = new ProfileStore(memory());
    const p = s.pad('gamepad', 'fixed');
    s.setPad('gamepad', 'fixed', {
      ...p,
      axes: { ...p.axes, pitch: { ...p.axes.pitch!, invert: true } },
    });
    const json = s.export();
    const t = new ProfileStore(memory());
    t.import(json);
    expect(t.pad('gamepad', 'fixed').axes.pitch!.invert).toBe(true);
    expect(t.pad('gamepad', 'fixed').buttons.fire).toEqual(['Pad7']);
    expect(() => t.import('{"version":2}')).toThrow();
    expect(() => t.import('nonsense')).toThrow();
    expect(t.pad('gamepad', 'fixed').axes.pitch!.invert).toBe(true);
    // An old file without a newer action gets its default.
    const old = JSON.parse(json);
    delete old.gamepad.fixed.buttons.padlock;
    expect(parseStored(JSON.stringify(old)).gamepad.fixed.buttons.padlock).toEqual(['Pad11']);
  });
});

describe('the jet and the helicopter on a synthetic gamepad', () => {
  let pad: FakePad;
  let layer: InputLayer;
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    pad = new FakePad();
    const src = new GamepadSource(() => [pad]);
    layer = new InputLayer(src, new ProfileStore(null));
    src.poll();
  });
  afterEach(() => vi.unstubAllGlobals());

  const frames = (input: { update(dt: number): void }, n: number) => {
    for (let i = 0; i < n; i++) {
      layer.source.poll();
      input.update(1 / 60);
    }
  };

  it('flies the stick, rudder and throttle, and presses the gear', () => {
    const input = new FlightInput(new EventTarget() as unknown as HTMLElement, null, layer);
    const actions: string[] = [];
    input.onAction = (a) => actions.push(a);
    input.enabled = true;
    input.reset(true);
    pad.axes[3] = 1; // right stick back: nose up
    pad.axes[2] = -0.5;
    frames(input, 1);
    expect(input.controls.pitch).toBeGreaterThan(0.9);
    expect(input.controls.roll).toBeLessThan(-0.2);
    pad.axes[3] = 0;
    pad.axes[2] = 0;
    // Throttle up: the parking brake comes off and the lever moves, then holds.
    pad.axes[1] = -1;
    frames(input, 60);
    expect(input.controls.parkingBrake).toBe(false);
    expect(input.controls.throttle).toBeGreaterThan(0.3);
    pad.axes[1] = 0;
    const held = input.controls.throttle;
    frames(input, 30);
    expect(input.controls.throttle).toBe(held);
    // Rudder from the left stick.
    pad.axes[0] = 1;
    frames(input, 1);
    expect(input.controls.yaw).toBeCloseTo(1);
    pad.axes[0] = 0;
    pad.set(0, 1);
    frames(input, 1);
    pad.set(0, 0);
    frames(input, 1);
    expect(actions).toEqual(['gear']);
    // The right trigger is the gun's trigger.
    pad.set(7, 1);
    frames(input, 1);
    expect(input.trigger).toBe(true);
    pad.set(7, 0);
    frames(input, 1);
    // Idle and pulled back brakes the wheels.
    input.controls.throttle = 0;
    pad.axes[1] = 1;
    frames(input, 1);
    expect(input.controls.brakeLeft).toBeGreaterThan(0.9);
    input.dispose();
  });

  it('looks around with the bumper held instead of flying, and pauses from Start under a menu', () => {
    const input = new FlightInput(new EventTarget() as unknown as HTMLElement, null, layer);
    const actions: string[] = [];
    input.onAction = (a) => actions.push(a);
    input.enabled = true;
    pad.set(4, 1);
    pad.axes[2] = 1;
    frames(input, 10);
    expect(input.lookHeld).toBe(true);
    expect(input.lookDelta.x).toBeGreaterThan(100);
    expect(input.controls.roll).toBe(0);
    // L1 + D-pad up is the master caution's chord: not the jet's.
    pad.set(12, 1);
    frames(input, 1);
    pad.set(12, 0);
    pad.set(4, 0);
    pad.axes[2] = 0;
    frames(input, 1);
    // Letting go of the look modifier recenters the view; the chord was the displays'.
    expect(actions).toEqual(['recenterView']);
    actions.length = 0;
    input.enabled = false;
    pad.set(0, 1);
    pad.set(9, 1);
    frames(input, 1);
    expect(actions).toEqual(['pause']);
    input.dispose();
  });

  it('commands the helicopter: cyclic as an attitude that springs back, collective, pedals', () => {
    const helo = new HeloInput(new EventTarget() as unknown as HTMLElement, null, layer);
    const actions: string[] = [];
    helo.onAction = (a) => actions.push(a);
    helo.enabled = true;
    expect(layer.aircraftClass).toBe('rotary');
    pad.axes[3] = 1;
    pad.axes[1] = -1;
    pad.axes[0] = 0.3;
    frames(helo, 1);
    const up = helo.command.mousePitch;
    expect(up).toBeGreaterThan(0.25);
    expect(helo.command.collective).toBeCloseTo(1);
    // The cross-talk guard: the thumb's sideways drift is no pedal.
    expect(helo.command.pedals).toBe(0);
    helo.consumed();
    pad.axes[3] = 0;
    pad.axes[1] = 0;
    frames(helo, 1);
    expect(helo.command.mousePitch).toBeCloseTo(-up);
    expect(helo.command.collective).toBe(0);
    pad.axes[0] = 0;
    // ✕ toggles the hover hold.
    pad.set(0, 1);
    frames(helo, 1);
    expect(actions).toEqual(['hoverHold']);
    expect(helo.command.toggleHover).toBe(true);
    helo.dispose();
  });
});

describe('menus, padlock and buffet', () => {
  const rect = (x: number, y: number) =>
    ({ left: x, top: y, width: 10, height: 10, right: x + 10, bottom: y + 10 }) as DOMRect;

  it('moves the focus to the nearest control in the pressed direction', () => {
    // A column of three buttons and one to the right of the middle one.
    const list = [rect(0, 0), rect(0, 40), rect(0, 80), rect(60, 44)].map((r) => ({ rect: r }));
    expect(nextInDirection(rect(0, 40), list, 'down')).toBe(2);
    expect(nextInDirection(rect(0, 40), list, 'up')).toBe(0);
    expect(nextInDirection(rect(0, 40), list, 'right')).toBe(3);
    expect(nextInDirection(rect(0, 40), list, 'left')).toBe(-1);
    expect(nextInDirection(null, list, 'down')).toBe(0);
  });

  it('starts no action from a press a menu consumed, and ends none on its release', () => {
    const pad = new FakePad();
    const src = new GamepadSource(() => [pad]);
    const layer = new InputLayer(src, new ProfileStore(null));
    const seen: string[] = [];
    layer.onAction((a, down) => seen.push(`${a}:${down}`));
    let menu = true;
    layer.onRaw((e) => menu && e.type === 'press' && e.code === 'Pad0');
    pad.set(0, 1);
    src.poll();
    menu = false;
    pad.set(0, 0);
    src.poll();
    expect(seen).toEqual([]);
    pad.set(0, 1);
    src.poll();
    expect(seen).toEqual(['gear:true']);
  });

  it('points the padlocked view at the target', () => {
    const f = new Vec3d(1, 0, 0);
    const u = new Vec3d(0, 1, 0);
    expect(padlockAngles(f, u, new Vec3d(1, 0, 0))).toEqual({ yaw: 0, pitch: -0 });
    // Right is f × u = +z: a target to the right turns the look a quarter round.
    expect(padlockAngles(f, u, new Vec3d(0, 0, 1)).yaw).toBeCloseTo(Math.PI / 2);
    // A target above lowers the eye (negative look pitch).
    expect(padlockAngles(f, u, new Vec3d(1, 1, 0).normalize()).pitch).toBeCloseTo(-Math.PI / 4);
  });

  it('buffets from the onset angle of attack to full', () => {
    expect(buffetFromAlpha(0.1, 0.3, 0.5)).toBe(0);
    expect(buffetFromAlpha(0.4, 0.3, 0.5)).toBeCloseTo(0.5);
    expect(buffetFromAlpha(0.9, 0.3, 0.5)).toBe(1);
  });
});

describe('the gamepad takes the controls from the mouse (decision 368)', () => {
  /** A canvas and document whose pointer lock the test controls (as tests/mouseCapture.test.ts). */
  function fakeLock() {
    const listeners = new Set<() => void>();
    const doc = {
      pointerLockElement: null as unknown,
      exitPointerLock() {
        this.pointerLockElement = null;
        listeners.forEach((fn) => fn());
      },
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    };
    const el = {
      requestPointerLock(): Promise<void> {
        doc.pointerLockElement = el;
        listeners.forEach((fn) => fn());
        return Promise.resolve();
      },
    };
    return { doc, el };
  }

  let pad: FakePad;
  let layer: InputLayer;
  let cap: MouseCapture;
  let view: EventTarget;
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    pad = new FakePad();
    const src = new GamepadSource(() => [pad]);
    layer = new InputLayer(src, new ProfileStore(null));
    src.poll();
    const f = fakeLock();
    cap = new MouseCapture(f.el, f.doc as never, () => 0);
    view = new EventTarget();
  });
  afterEach(() => vi.unstubAllGlobals());

  const frames = (input: { update(dt: number): void }, n: number) => {
    for (let i = 0; i < n; i++) {
      layer.source.poll();
      input.update(1 / 60);
    }
  };
  const click = () =>
    view.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, pointerId: 1 }));

  it('stops a captured mouse from holding the stick once the pad moves, until Tab', () => {
    const input = new FlightInput(view as unknown as HTMLElement, cap, layer);
    const messages: string[] = [];
    input.onMessage = (t) => messages.push(t);
    input.enabled = true;
    input.mode = 'direct';
    cap.grab();
    // The mouse left off center: it holds the stick back.
    input.moveCursor(0, 300, 1600, 900);
    frames(input, 1);
    expect(input.controls.pitch).toBeGreaterThan(0.5);
    expect(input.padOwns).toBe(false);
    // One touch of the pad's stick: the mouse is freed and centered.
    pad.axes[2] = 0.5;
    frames(input, 1);
    expect(input.padOwns).toBe(true);
    expect(cap.captured).toBe(false);
    expect(input.cursor).toEqual({ x: 0, y: 0 });
    expect(messages.some((m) => m.includes('mouse is off'))).toBe(true);
    // The pad let go: nothing holds the stick, and the hold may fly (decision 306).
    pad.axes[2] = 0;
    frames(input, 30);
    expect(input.controls.pitch).toBe(0);
    expect(input.controls.roll).toBe(0);
    expect(input.handsOff).toBe(true);
    // A click on the view does not give the mouse back.
    click();
    expect(cap.captured).toBe(false);
    // Tab (the capture key) does.
    cap.grab();
    frames(input, 1);
    expect(input.padOwns).toBe(false);
    input.moveCursor(0, 300, 1600, 900);
    frames(input, 1);
    expect(input.controls.pitch).toBeGreaterThan(0.5);
    input.dispose();
  });

  it('turns mouse aim off when a pad button is pressed, and the stick flies directly', () => {
    const input = new FlightInput(view as unknown as HTMLElement, cap, layer);
    input.enabled = true;
    input.mode = 'mouse-aim';
    input.directOnGround = false;
    cap.grab();
    frames(input, 1);
    expect(input.mouseAimFlies).toBe(true);
    pad.set(1, 1);
    frames(input, 1);
    pad.set(1, 0);
    frames(input, 1);
    expect(input.padOwns).toBe(true);
    expect(input.mouseAimFlies).toBe(false);
    expect(cap.captured).toBe(false);
    pad.axes[3] = 1;
    frames(input, 1);
    expect(input.controls.pitch).toBeGreaterThan(0.9);
    expect(input.keyStick.pitchWeight).toBe(0);
    input.dispose();
  });

  it("frees the helicopter's mouse when the pad moves, and ignores the mouse until Tab", () => {
    const helo = new HeloInput(view as unknown as HTMLElement, cap, layer);
    helo.enabled = true;
    cap.grab();
    frames(helo, 1);
    pad.axes[1] = -1;
    frames(helo, 1);
    expect(helo.padOwns).toBe(true);
    expect(cap.captured).toBe(false);
    pad.axes[1] = 0;
    frames(helo, 1);
    click();
    expect(cap.captured).toBe(false);
    cap.grab();
    frames(helo, 1);
    expect(helo.padOwns).toBe(false);
    helo.dispose();
  });
});
