/**
 * Free Flight's keys while a menu has the controls (ui/flight/flightInput.ts):
 * the pause key closes the pause menu it opened, a key released under the
 * menu is not left held, and nothing else acts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlightInput } from '../src/ui/flight/flightInput';
import type { FlightAction } from '../src/ui/flight/flightInput';

describe('flight input under the pause menu', () => {
  let win: EventTarget;
  let input: FlightInput;
  let actions: FlightAction[];

  const key = (type: 'keydown' | 'keyup', code: string) => {
    const e = new Event(type, { cancelable: true }) as Event & { code: string };
    e.code = code;
    win.dispatchEvent(e);
    return e;
  };
  const press = (code: string) => {
    key('keydown', code);
    key('keyup', code);
  };

  beforeEach(() => {
    win = new EventTarget();
    vi.stubGlobal('window', win);
    input = new FlightInput(new EventTarget() as unknown as HTMLElement);
    input.enabled = true;
    actions = [];
    // As the app does: the pause action hands the controls to the menu and takes them back.
    input.onAction = (a) => {
      actions.push(a);
      if (a === 'pause') input.enabled = !input.enabled;
    };
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('pauses with Esc and resumes with Esc', () => {
    press('Escape');
    expect(input.enabled).toBe(false);
    press('Escape');
    expect(input.enabled).toBe(true);
    expect(actions).toEqual(['pause', 'pause']);
  });

  it('takes the next Esc after the menu was closed with its button', () => {
    press('Escape');
    // The Resume button.
    input.enabled = true;
    press('Escape');
    expect(actions).toEqual(['pause', 'pause']);
    expect(input.enabled).toBe(false);
  });

  it('lets nothing else act under the menu, and holds no key that was released there', () => {
    key('keydown', 'KeyS');
    input.update(0.2);
    expect(input.controls.pitch).toBeGreaterThan(0);
    press('Escape');
    press('KeyG');
    expect(actions).toEqual(['pause']);
    // The stick key is let go while the menu shows.
    key('keyup', 'KeyS');
    press('Escape');
    input.update(1);
    expect(input.controls.pitch).toBe(0);
    press('KeyG');
    expect(actions).toEqual(['pause', 'pause', 'gear']);
  });

  it('leaves the keys to the page while a menu has the controls', () => {
    expect(key('keydown', 'KeyG').defaultPrevented).toBe(true);
    key('keyup', 'KeyG');
    input.enabled = false;
    expect(key('keydown', 'KeyG').defaultPrevented).toBe(false);
    expect(key('keydown', 'Escape').defaultPrevented).toBe(false);
  });
});

describe('the keys in mouse aim (decision 219)', () => {
  let win: EventTarget;
  let input: FlightInput;
  const key = (type: 'keydown' | 'keyup', code: string) => {
    const e = new Event(type, { cancelable: true }) as Event & { code: string };
    e.code = code;
    win.dispatchEvent(e);
  };
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) input.update(1 / 60);
  };

  beforeEach(() => {
    win = new EventTarget();
    vi.stubGlobal('window', win);
    input = new FlightInput(new EventTarget() as unknown as HTMLElement);
    input.enabled = true;
    input.mode = 'mouse-aim';
    input.directOnGround = false;
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('lets a held roll key take the roll from the director, and hands it back on release', () => {
    // The director's last command, as the app leaves it in the controls.
    input.controls.roll = 0.2;
    input.controls.pitch = 0.1;
    key('keydown', 'KeyA');
    frames(30);
    const ctl = { ...input.controls, roll: 0.2, pitch: 0.1 };
    input.overrideStick(ctl);
    // Roll left at full stick after half a second; pitch stays the director's.
    expect(ctl.roll).toBeCloseTo(-1, 6);
    expect(ctl.pitch).toBe(0.1);
    key('keyup', 'KeyA');
    frames(9);
    const mid = { ...input.controls, roll: 0.2 };
    input.overrideStick(mid);
    expect(mid.roll).toBeGreaterThan(-1);
    expect(mid.roll).toBeLessThan(0.2);
    frames(12);
    const back = { ...input.controls, roll: 0.2 };
    input.overrideStick(back);
    expect(back.roll).toBe(0.2);
  });

  it('keeps the rudder keys working', () => {
    key('keydown', 'KeyE');
    frames(30);
    expect(input.controls.yaw).toBeCloseTo(1, 6);
  });

  it('leaves the stick to the keys directly in direct mode', () => {
    input.mode = 'direct';
    key('keydown', 'KeyS');
    frames(30);
    expect(input.controls.pitch).toBeCloseTo(1, 6);
    expect(input.keyStick.pitchWeight).toBe(0);
  });
});
