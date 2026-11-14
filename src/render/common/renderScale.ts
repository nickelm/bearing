/**
 * Adaptive render resolution (decision 69). The terrain shader's cost grows
 * with the number of pixels, and a laptop at 4K with a device pixel ratio of
 * 1.5–2 shades three to four times the pixels of a 1080p screen. The
 * controller watches the frame time and scales the canvas's backing store
 * (relative to the device pixel ratio) so frames stay near the target.
 *
 * - Frame times are smoothed (exponential average), so tile-building spikes
 *   do not trigger changes. A single frame counts as at most HITCH targets:
 *   the first frame after a hidden tab or a stall of the page lasts seconds
 *   and says nothing about the resolution.
 * - Shading cost scales with the pixel count, the square of the scale, so a
 *   slow frame steps the scale by √(target / measured), at most 40% at once.
 * - Raising the scale needs a clear margin (frames under 70% of the target)
 *   and a longer wait than lowering it, so the scale does not oscillate.
 * - Each change resizes the framebuffers, so changes come at most every
 *   HOLD_DOWN_MS (or HOLD_UP_MS upward) and in steps of 5%.
 * - **Probes.** A display shows whole refresh periods: a frame that takes 20 ms
 *   is on screen for 33 ms at 60 Hz, and a browser that caps the page at 30
 *   frames per second (a laptop saving energy) shows every frame for 33 ms.
 *   The measured time then sits on the target whatever the margin, never under
 *   70% of it, and the scale would stay wherever a slow spell left it. So
 *   while the frame time is on target the controller tries one step up every
 *   PROBE_MS. A scale fails if a probe to it pushes the frame time over the
 *   target (it is taken back at once), or if the scale was slightly too much:
 *   it had to come down by a little (the smoothed frame time at most SLOW
 *   targets) and the lower scale then stood for PROBE_MS, as when a probe
 *   passed in the trough of a load that wanders. A slow spell, which costs
 *   far more and takes several steps, says nothing about the scale. A scale
 *   that failed is tried again after PROBE_RETRY_MS, twice as long after each
 *   further failure (up to PROBE_RETRY_MOST_MS), and each scale above it
 *   waits as long. So a machine that holds the target at one scale and not at
 *   the next pays for a failed probe (about a second of slower frames and two
 *   resizes) after 1, 3, 7 and 15 minutes and then every ten, and a wandering
 *   load is not chased. A failed scale is forgotten once it has held for the
 *   retry time, or once clear headroom has carried the scale well past it:
 *   the load has gone.
 */

export const RENDER_SCALES = ['auto', '100%', '75%', '50%', '35%'] as const;
export type RenderScaleSetting = (typeof RENDER_SCALES)[number];

const HOLD_DOWN_MS = 500;
const HOLD_UP_MS = 2000;
const SMOOTHING = 0.1;
/** Frames ignored after a change (the resize itself makes a slow frame). */
const SETTLE_FRAMES = 10;
/**
 * A frame longer than this many targets counts as this many. A machine that is
 * this slow on every frame still steps down by the most a step allows.
 */
const HITCH = 4;
/** One step of the scale. */
const STEP = 0.05;
/** On target for this long (ms), the controller tries one step up. */
const PROBE_MS = 2000;
/** Wait before a scale that failed is tried again (ms): at first, and at most. */
const PROBE_RETRY_MS = 60_000;
const PROBE_RETRY_MOST_MS = 600_000;
/** A probe holds if the mean frame time stays under this share of the target. */
const ON_TARGET = 1.03;
/** Frames a probe is judged over; their slowest one is left out (a hitch). */
const PROBE_FRAMES = 16;
/** A probe fails early at this many frames over SLOW targets. */
const PROBE_SLOW_FRAMES = 4;
/**
 * Frame time, in targets, up to which a scale is slightly too much. A step down from a
 * smoothed frame time under it marks the scale as failed; over it, something else is slow.
 */
const SLOW = 1.25;

export class RenderScaleController {
  /** Current scale relative to the device pixel ratio. */
  scale = 1;
  private average = 0;
  private frames = 0;
  private changedAt = -Infinity;
  /** The probe being judged: the scale before it, and the frames since. */
  private probe: {
    from: number;
    count: number;
    sum: number;
    longest: number;
    slow: number;
  } | null = null;
  /** The scale a small step down has just left: it has failed if the lower one stands. */
  private suspect: number | null = null;
  /** The scale that last failed, and the scale from which probes wait for the retry time. */
  private failedAt = Infinity;
  private ceiling = Infinity;
  private retryMs = PROBE_RETRY_MS;

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
    const ms = Math.min(frameMs, HITCH * this.targetMs);
    this.average =
      this.frames === SETTLE_FRAMES + 1 ? ms : this.average + (ms - this.average) * SMOOTHING;
    const probe = this.probe;
    if (probe !== null) {
      probe.count++;
      probe.sum += ms;
      probe.longest = Math.max(probe.longest, ms);
      if (ms > this.targetMs * SLOW) probe.slow++;
      const judged = probe.count >= PROBE_FRAMES;
      const mean = (probe.sum - probe.longest) / Math.max(1, probe.count - 1);
      if (probe.slow >= PROBE_SLOW_FRAMES || (judged && mean > this.targetMs * ON_TARGET)) {
        // Over the target: back to the scale that held, and this one waits.
        this.failed(this.scale);
        this.probe = null;
        this.scale = probe.from;
        this.restart(nowMs);
        return this.scale;
      }
      if (!judged) return null;
      this.probe = null;
    }
    const since = nowMs - this.changedAt;
    if (this.suspect !== null && since >= PROBE_MS) {
      // One small step down was enough: the scale above was slightly too much.
      this.failed(this.suspect);
      this.suspect = null;
    }
    let next = this.scale;
    let probing = false;
    if (this.average > this.targetMs * 1.1 && since >= HOLD_DOWN_MS) {
      const factor = Math.min(0.95, Math.max(0.6, Math.sqrt(this.targetMs / this.average)));
      next = this.scale * factor;
    } else if (this.average < this.targetMs * 0.7 && since >= HOLD_UP_MS) {
      next = this.scale * 1.1;
    } else if (
      this.scale < this.maxScale &&
      this.average <= this.targetMs * ON_TARGET &&
      since >= (this.scale + STEP >= this.ceiling - STEP / 2 ? this.retryMs : PROBE_MS)
    ) {
      next = this.scale + STEP;
      probing = true;
    }
    next = Math.min(this.maxScale, Math.max(this.minScale, Math.round(next / STEP) * STEP));
    // Keep the steps exact (0.05 is no binary fraction).
    next = Math.round(next * 100) / 100;
    if (next === this.scale) return null;
    const suspect = this.suspect;
    this.suspect = null;
    if (probing) {
      // The scale that once failed has held for the retry time: the load has gone.
      if (this.scale >= this.ceiling - STEP / 2) this.forget();
      this.probe = { from: this.scale, count: 0, sum: 0, longest: 0, slow: 0 };
    } else if (next < this.scale) {
      // Down by a little: this scale has failed, if the lower one then stands. The first of
      // several steps down counts (a load that rises slowly), a slow spell's steps do not.
      if (this.average <= this.targetMs * SLOW) this.suspect = suspect ?? this.scale;
    } else if (next >= this.failedAt + 2 * STEP - STEP / 2) {
      // Clear headroom has carried the scale well past the one that failed: the load has gone.
      this.forget();
    } else if (next >= this.ceiling - STEP / 2) {
      // Clear headroom at a scale that once failed: the load is lighter for now. What lies
      // above still waits, or a load that comes and goes would be chased.
      this.ceiling = next + STEP;
    }
    this.scale = next;
    this.restart(nowMs);
    return next;
  }

  /**
   * Sets the scale (e.g. a fixed GUI choice) and restarts the measurement. Another scale
   * than the controller's own also drops what the probes have learned.
   */
  set(scale: number, nowMs: number): void {
    const next = Math.min(this.maxScale, Math.max(this.minScale, scale));
    if (next !== this.scale) {
      this.probe = null;
      this.suspect = null;
      this.forget();
    }
    this.scale = next;
    this.restart(nowMs);
  }

  /**
   * The load has changed (another view, other quality settings): restarts the measurement
   * and drops what the probes have learned, so the scale finds its place anew.
   */
  reset(nowMs: number): void {
    this.probe = null;
    this.suspect = null;
    this.forget();
    this.restart(nowMs);
  }

  /** `scale` was too much: it waits, longer each time it fails again. */
  private failed(scale: number): void {
    if (scale >= this.ceiling - STEP / 2) {
      this.retryMs = Math.min(PROBE_RETRY_MOST_MS, this.retryMs * 2);
    } else {
      this.failedAt = scale;
      this.ceiling = scale;
      this.retryMs = PROBE_RETRY_MS;
    }
  }

  private forget(): void {
    this.failedAt = Infinity;
    this.ceiling = Infinity;
    this.retryMs = PROBE_RETRY_MS;
  }

  private restart(nowMs: number): void {
    this.frames = 0;
    this.changedAt = nowMs;
  }
}
