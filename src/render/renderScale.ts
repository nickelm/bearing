/**
 * Adaptive render resolution (decision 69). The terrain shader's cost grows
 * with the number of pixels, and a laptop at 4K with a device pixel ratio of
 * 1.5–2 shades three to four times the pixels of a 1080p screen. The
 * controller watches the frame time and scales the canvas's backing store
 * (relative to the device pixel ratio) so frames stay near the target.
 *
 * - Frame times are smoothed (exponential average), so tile-building spikes
 *   do not trigger changes.
 * - Shading cost scales with the pixel count, the square of the scale, so a
 *   slow frame steps the scale by √(target / measured), at most 40% at once.
 * - Raising the scale needs a clear margin (frames under 70% of the target)
 *   and a longer wait than lowering it, so the scale does not oscillate.
 * - Each change resizes the framebuffers, so changes come at most every
 *   HOLD_DOWN_MS (or HOLD_UP_MS upward) and in steps of 5%.
 */

export const RENDER_SCALES = ['auto', '100%', '75%', '50%', '35%'] as const;
export type RenderScaleSetting = (typeof RENDER_SCALES)[number];

const HOLD_DOWN_MS = 500;
const HOLD_UP_MS = 2000;
const SMOOTHING = 0.1;
/** Frames ignored after a change (the resize itself makes a slow frame). */
const SETTLE_FRAMES = 10;

export class RenderScaleController {
  /** Current scale relative to the device pixel ratio. */
  scale = 1;
  private average = 0;
  private frames = 0;
  private changedAt = -Infinity;

  constructor(
    /** Frame time to hold (ms): 30 frames per second by default. */
    public targetMs = 1000 / 30,
    readonly minScale = 0.35,
    readonly maxScale = 1,
  ) {}

  /** Fixed scale from a GUI setting, or null for automatic. */
  static fixed(setting: RenderScaleSetting): number | null {
    return setting === 'auto' ? null : Number(setting.replace('%', '')) / 100;
  }

  /** Records a frame; returns the new scale when it changed, else null. */
  record(frameMs: number, nowMs: number): number | null {
    this.frames++;
    if (this.frames <= SETTLE_FRAMES) return null;
    this.average =
      this.frames === SETTLE_FRAMES + 1
        ? frameMs
        : this.average + (frameMs - this.average) * SMOOTHING;
    const since = nowMs - this.changedAt;
    let next = this.scale;
    if (this.average > this.targetMs * 1.1 && since >= HOLD_DOWN_MS) {
      const factor = Math.min(0.95, Math.max(0.6, Math.sqrt(this.targetMs / this.average)));
      next = this.scale * factor;
    } else if (this.average < this.targetMs * 0.7 && since >= HOLD_UP_MS) {
      next = this.scale * 1.1;
    }
    next = Math.min(this.maxScale, Math.max(this.minScale, Math.round(next * 20) / 20));
    if (next === this.scale) return null;
    this.set(next, nowMs);
    return next;
  }

  /** Sets the scale (e.g. a fixed GUI choice) and restarts the measurement. */
  set(scale: number, nowMs: number): void {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, scale));
    this.frames = 0;
    this.changedAt = nowMs;
  }
}
