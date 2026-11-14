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
