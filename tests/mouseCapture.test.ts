/**
 * The mouse capture shared by the jet and the helicopters (decision 193):
 * one key grabs and frees the pointer lock in both, a loss the player did not
 * ask for is reported (Free Flight pauses), a refused grab is retried a few
 * times and then reported, and the jet's cursor moves by relative motion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLIGHT_BINDINGS, FlightInput } from '../src/ui/flight/flightInput';
import { HELO_BINDINGS, HeloInput } from '../src/ui/flight/heloInput';
import { MouseCapture, RETRY_DELAYS } from '../src/ui/flight/mouseCapture';
import type { CaptureDocument } from '../src/ui/flight/mouseCapture';

/** A document and a canvas whose pointer lock the test controls. */
function fakeLock(grant: () => boolean = () => true) {
  const listeners = new Set<() => void>();
  const doc: CaptureDocument & { pointerLockElement: unknown; fire(): void } = {
    pointerLockElement: null,
    exitPointerLock() {
      this.pointerLockElement = null;
      this.fire();
    },
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    fire: () => listeners.forEach((fn) => fn()),
  };
  const requests: number[] = [];
  const el = {
    requestPointerLock(): Promise<void> {
      requests.push(requests.length);
      if (!grant()) return Promise.reject(new Error('Too many pointer lock requests'));
      doc.pointerLockElement = el;
      doc.fire();
      return Promise.resolve();
    },
  };
  const timers: { fn: () => void; ms: number }[] = [];
  const schedule = (fn: () => void, ms: number) => timers.push({ fn, ms });
  return { doc, el, requests, timers, schedule };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('mouse capture', () => {
  it('grabs and frees the mouse with one toggle, and reports no loss for its own release', () => {
    const f = fakeLock();
    const cap = new MouseCapture(f.el, f.doc, f.schedule);
    const lost = vi.fn();
    cap.onLost = lost;
    cap.toggle();
    expect(cap.captured).toBe(true);
    cap.toggle();
    expect(cap.captured).toBe(false);
    cap.toggle();
    expect(cap.captured).toBe(true);
    expect(lost).not.toHaveBeenCalled();
  });

  it('reports a loss the player did not ask for (Escape, focus), and the next toggle grabs', () => {
    const f = fakeLock();
    const cap = new MouseCapture(f.el, f.doc, f.schedule);
    const lost = vi.fn();
    cap.onLost = lost;
    cap.grab();
    // The browser drops the lock itself.
    f.doc.pointerLockElement = null;
    f.doc.fire();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(cap.captured).toBe(false);
    cap.toggle();
    expect(cap.captured).toBe(true);
  });

  it('retries a refused grab with growing delays, then reports the refusal', async () => {
    const f = fakeLock(() => false);
    const cap = new MouseCapture(f.el, f.doc, f.schedule);
    const refused = vi.fn();
    cap.onRefused = refused;
    cap.grab();
    for (const ms of RETRY_DELAYS) {
      await flush();
      expect(f.timers.at(-1)?.ms).toBe(ms);
      f.timers.at(-1)!.fn();
    }
    await flush();
    expect(f.requests.length).toBe(RETRY_DELAYS.length + 1);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(cap.captured).toBe(false);
  });

  it('succeeds on a retry, and a release cancels pending retries', async () => {
    let n = 0;
    const f = fakeLock(() => ++n > 2);
    const cap = new MouseCapture(f.el, f.doc, f.schedule);
    cap.grab();
    await flush();
    f.timers.at(-1)!.fn();
    await flush();
    f.timers.at(-1)!.fn();
    expect(cap.captured).toBe(true);

    n = -10;
    cap.release();
    cap.grab();
    await flush();
    const pending = f.timers.at(-1)!;
    cap.release();
    const before = f.requests.length;
    pending.fn();
    expect(f.requests.length).toBe(before);
    expect(cap.captured).toBe(false);
  });
});

describe('the capture key and the inputs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is one key, the same for the jet and the helicopters, bound to nothing else', () => {
    expect(FLIGHT_BINDINGS.mouseCapture).toEqual(HELO_BINDINGS.mouseCapture);
    const key = FLIGHT_BINDINGS.mouseCapture[0];
    for (const table of [FLIGHT_BINDINGS, HELO_BINDINGS] as Record<string, string[]>[]) {
      const users = Object.entries(table).filter(([, codes]) => codes.includes(key));
      expect(users.map(([a]) => a)).toEqual(['mouseCapture']);
    }
  });

  it('switches the inversion with one key, the same in the jet and the helicopters', () => {
    expect(FLIGHT_BINDINGS.invertMouse).toEqual(HELO_BINDINGS.invertMouse);
    const key = FLIGHT_BINDINGS.invertMouse[0];
    for (const table of [FLIGHT_BINDINGS, HELO_BINDINGS] as Record<string, string[]>[]) {
      const users = Object.entries(table).filter(([, codes]) => codes.includes(key));
      expect(users.map(([a]) => a)).toEqual(['invertMouse']);
    }
  });

  it("inverts the jet's cursor: mouse forward lowers it (decision 196)", () => {
    vi.stubGlobal('window', new EventTarget());
    const f = fakeLock();
    const input = new FlightInput(
      new EventTarget() as unknown as HTMLElement,
      new MouseCapture(f.el, f.doc, f.schedule),
    );
    // Mouse forward (up the desk) is a negative movementY.
    input.moveCursor(0, -90, 1600, 900);
    expect(input.cursor.y).toBeCloseTo(0.2);
    input.centerCursor();
    input.invertStick = true;
    input.moveCursor(0, -90, 1600, 900);
    // Direct is the default mode: its own inversion applies, not mouse aim's.
    expect(input.cursor.y).toBeCloseTo(-0.2);
    input.centerCursor();
    input.mode = 'mouse-aim';
    input.moveCursor(0, -90, 1600, 900);
    expect(input.cursor.y).toBeCloseTo(0.2);
    input.dispose();
  });

  it('rotates on the wheels with the ring in mouse aim, and with the stick in direct (decision 207)', () => {
    vi.stubGlobal('window', new EventTarget());
    const f = fakeLock();
    const cap = new MouseCapture(f.el, f.doc, f.schedule);
    const input = new FlightInput(new EventTarget() as unknown as HTMLElement, cap);
    input.enabled = true;
    cap.grab();
    input.directOnGround = true;
    input.mode = 'mouse-aim';
    input.aimRotates = true;
    input.cursor.y = 0.5;
    input.update(1 / 60);
    // The ring above the center pulls the stick back.
    expect(input.controls.pitch).toBeGreaterThan(0.6);
    input.mode = 'direct';
    input.update(1 / 60);
    // The direct stick above the center is forward.
    expect(input.controls.pitch).toBeLessThan(-0.6);
    input.dispose();
  });

  it("moves the jet's cursor by relative motion, half the view for full travel", () => {
    vi.stubGlobal('window', new EventTarget());
    const f = fakeLock();
    const input = new FlightInput(
      new EventTarget() as unknown as HTMLElement,
      new MouseCapture(f.el, f.doc, f.schedule),
    );
    input.moveCursor(400, -150, 1600, 900);
    expect(input.cursor.x).toBeCloseTo(0.5);
    expect(input.cursor.y).toBeCloseTo(1 / 3);
    input.moveCursor(4000, 4000, 1600, 900);
    expect(input.cursor).toEqual({ x: 1, y: -1 });
    input.reset(false);
    expect(input.cursor).toEqual({ x: 0, y: 0 });
    input.dispose();
  });

  it("reads the helicopter's capture from the shared lock", () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    const f = fakeLock();
    const cap = new MouseCapture(f.el, f.doc, f.schedule);
    const helo = new HeloInput(new EventTarget() as unknown as HTMLElement, cap);
    expect(helo.locked).toBe(false);
    cap.grab();
    expect(helo.locked).toBe(true);
    helo.release();
    expect(cap.captured).toBe(false);
    helo.dispose();
  });
});
