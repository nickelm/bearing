/**
 * Mouse capture shared by every flown aircraft (decision 193): one pointer lock
 * on the view that the fixed-wing and the helicopter inputs both read, grabbed
 * and released by one key (Tab, in both binding tables) or grabbed by a click
 * on the view. A free mouse is cursor mode (Proposal 0006): the flight director
 * holds what the mouse last commanded while the player uses the displays.
 *
 * Browsers grant pointer lock only within a user gesture. A key press is one,
 * a key release is not, and the gesture's activation lapses after about five
 * seconds, so capture toggles on a press rather than following a held key.
 * Chromium also refuses requests that come too fast ("too many pointer lock
 * requests in a short window"); a refused grab is retried a few times with a
 * growing delay while it is still wanted, inside the press's activation.
 */

/** The element that takes the lock: the view's canvas. */
export interface CaptureElement {
  requestPointerLock(): Promise<void> | void;
}

/** The parts of `document` capture uses. */
export interface CaptureDocument {
  readonly pointerLockElement: unknown;
  exitPointerLock(): void;
  addEventListener(type: 'pointerlockchange', fn: () => void): void;
  removeEventListener(type: 'pointerlockchange', fn: () => void): void;
}

/** Delays (ms) of the retries after a refused grab; the last lands inside the press's activation. */
export const RETRY_DELAYS = [400, 800, 1200, 1600] as const;

export type Schedule = (fn: () => void, ms: number) => unknown;

export class MouseCapture {
  /** Whether the view holds the pointer lock now. */
  captured = false;
  /**
   * The browser took the mouse back without being asked: Escape, or the window
   * lost focus. Free Flight pauses.
   */
  onLost: (() => void) | null = null;
  /** The browser refused every retry of a grab. */
  onRefused: (() => void) | null = null;
  /** Called after every change of `captured`. */
  onChange: ((captured: boolean) => void) | null = null;

  private wanted = false;
  /** Counts grabs, so a retry of an older grab never runs after a newer release or grab. */
  private generation = 0;
  private readonly changed: () => void;

  constructor(
    private readonly el: CaptureElement,
    private readonly doc: CaptureDocument | null = typeof document === 'undefined'
      ? null
      : document,
    private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
  ) {
    this.changed = () => {
      const now = this.doc?.pointerLockElement === this.el;
      if (now === this.captured) return;
      this.captured = now;
      if (!now && this.wanted) {
        // Not released by us: the browser gave the mouse back.
        this.wanted = false;
        this.generation++;
        this.onLost?.();
      }
      this.onChange?.(now);
    };
    this.doc?.addEventListener('pointerlockchange', this.changed);
  }

  /** Captures the mouse. Call from a key press or click handler (a user gesture). */
  grab(): void {
    if (!this.doc || this.wanted) return;
    this.wanted = true;
    this.request(++this.generation, 0);
  }

  /** Gives the mouse back (cursor mode, a menu opens). */
  release(): void {
    this.wanted = false;
    this.generation++;
    if (this.captured) this.doc?.exitPointerLock();
  }

  /** The capture key: grabs a free mouse, frees a captured one. */
  toggle(): void {
    if (this.wanted || this.captured) this.release();
    else this.grab();
  }

  private request(gen: number, attempt: number): void {
    let p: Promise<void> | void;
    try {
      p = this.el.requestPointerLock();
    } catch {
      p = Promise.reject(new Error('requestPointerLock threw'));
    }
    // Older browsers return nothing and report a refusal by `pointerlockerror` only.
    if (!p || typeof p.then !== 'function') return;
    p.then(undefined, () => {
      if (gen !== this.generation || !this.wanted || this.captured) return;
      const delay = RETRY_DELAYS[attempt];
      if (delay === undefined) {
        this.wanted = false;
        this.onRefused?.();
        return;
      }
      this.schedule(() => {
        if (gen === this.generation && this.wanted && !this.captured)
          this.request(gen, attempt + 1);
      }, delay);
    });
  }

  dispose(): void {
    this.release();
    this.doc?.removeEventListener('pointerlockchange', this.changed);
  }
}
