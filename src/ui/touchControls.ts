/**
 * On-screen controls for the observer camera on touch screens (decision 114):
 * what the keyboard does on a desktop.
 *
 * - **Walk stick** (bottom left): push to move; speed grows with the push, as
 *   W/A/S/D at full deflection. A small dead zone keeps a resting thumb still.
 * - **Height slider** (bottom right): push up to rise and down to sink, as R/F;
 *   it springs back to the middle on release.
 * - **×5** (above the slider): toggles the fast pace, as holding Shift.
 *
 * Looking around and zooming stay gestures on the view itself
 * (orbitCamera.ts `attachOrbitInput`): one finger looks, two fingers pinch.
 * Each control captures its own pointer, so both thumbs work at once.
 * Panels follow visual-style Part I, _User Interface_: dark translucent,
 * square corners, amber when active.
 */

/** What the controls drive: analog walk and climb in −1..1, and the fast pace. */
export interface StickInput {
  forward: number;
  right: number;
  climb: number;
  boost: number;
}

/** Fraction of the stick's travel that does nothing. */
export const STICK_DEAD_ZONE = 0.12;

/**
 * Walk input from a thumb `dx`, `dy` pixels from the stick's center (screen y
 * down), on a stick of `radius` pixels of travel: clamped to the unit disk,
 * with the dead zone removed and the rest rescaled to reach 1.
 */
export function stickValue(
  dx: number,
  dy: number,
  radius: number,
): { forward: number; right: number } {
  const len = Math.hypot(dx, dy) / radius;
  if (len <= STICK_DEAD_ZONE) return { forward: 0, right: 0 };
  const mag = Math.min(1, (len - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE));
  const k = mag / (len * radius);
  return { forward: -dy * k, right: dx * k };
}

/** Climb input from a thumb `dy` pixels below the slider's middle, with `half` pixels of travel. */
export function sliderValue(dy: number, half: number): number {
  const v = Math.max(-1, Math.min(1, -dy / half));
  if (Math.abs(v) <= STICK_DEAD_ZONE) return 0;
  return Math.sign(v) * ((Math.abs(v) - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE));
}

const STICK_SIZE = 132;
const KNOB_SIZE = 56;
const SLIDER_HEIGHT = 160;

export class TouchControls {
  private readonly el: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly sliderKnob: HTMLDivElement;
  private readonly fast: HTMLButtonElement;
  private shown = false;

  constructor(
    private readonly input: StickInput,
    parent: HTMLElement = document.body,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'touch-controls';
    this.el.hidden = true;

    const stick = document.createElement('div');
    stick.className = 'touch-stick';
    stick.title = 'Walk';
    this.knob = document.createElement('div');
    this.knob.className = 'touch-knob';
    stick.appendChild(this.knob);

    const right = document.createElement('div');
    right.className = 'touch-right';
    this.fast = document.createElement('button');
    this.fast.type = 'button';
    this.fast.className = 'touch-fast';
    this.fast.textContent = '×5';
    this.fast.title = 'Move five times faster';
    this.fast.addEventListener('click', () => {
      this.input.boost = this.input.boost ? 0 : 1;
      this.fast.classList.toggle('active', this.input.boost > 0);
    });
    const slider = document.createElement('div');
    slider.className = 'touch-slider';
    slider.title = 'Height';
    this.sliderKnob = document.createElement('div');
    this.sliderKnob.className = 'touch-knob';
    slider.appendChild(this.sliderKnob);
    right.append(this.fast, slider);

    this.el.append(stick, right);
    parent.appendChild(this.el);

    const travel = (STICK_SIZE - KNOB_SIZE) / 2;
    this.track(stick, (dx, dy) => {
      const v = stickValue(dx, dy, travel);
      this.input.forward = v.forward;
      this.input.right = v.right;
      const len = Math.hypot(dx, dy);
      const k = len > travel ? travel / len : 1;
      this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    });
    const half = (SLIDER_HEIGHT - KNOB_SIZE) / 2;
    this.track(slider, (_dx, dy) => {
      this.input.climb = sliderValue(dy, half);
      const y = Math.max(-half, Math.min(half, dy));
      this.sliderKnob.style.transform = `translate(0, ${y}px)`;
    });
  }

  /** Shows or hides the controls; hiding releases them. */
  set visible(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.el.hidden = !on;
    if (!on) {
      this.input.forward = this.input.right = this.input.climb = 0;
      this.knob.style.transform = this.sliderKnob.style.transform = '';
    }
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Follows one pointer on `area` from press to release, reporting its offset from the center. */
  private track(area: HTMLElement, move: (dx: number, dy: number) => void): void {
    let id: number | null = null;
    const offset = (e: PointerEvent) => {
      const r = area.getBoundingClientRect();
      move(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    };
    area.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      area.setPointerCapture(e.pointerId);
      offset(e);
      e.preventDefault();
    });
    area.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) offset(e);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      move(0, 0);
    };
    area.addEventListener('pointerup', release);
    area.addEventListener('pointercancel', release);
    area.addEventListener('lostpointercapture', release);
  }
}

/** Whether this device has a touch screen (shows the controls; desktops keep the keyboard). */
export function hasTouch(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 0 ||
      (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches))
  );
}
