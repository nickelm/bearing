/**
 * Adaptive render resolution (decision 69). The terrain shader's cost grows
 * with the number of pixels, and a laptop at 4K with a device pixel ratio of
 * 1.5–2 shades three to four times the pixels of a 1080p screen. The
 * controller watches the frame time and scales the canvas's backing store
 * (relative to the device pixel ratio) so frames stay near the target.
 *
 * - Frame times are smoothed (exponential average). A single frame counts as
 *   at most HITCH targets: the first frame after a hidden tab or a stall of
 *   the page lasts seconds and says nothing about the resolution.
 * - One long frame (a tile build, a shader compile, a collected heap) says
 *   nothing about it either, and still lifts the average over the target for
 *   some ten frames. So the scale steps down only when SLOW_FRAMES of the last
 *   RECENT frames were slow. Where the display holds the frame time on the
 *   target, each such frame used to cost a step, which the probes won back
 *   only a minute later: the scale sank to its floor on a fast machine.
 * - A load can also come as one long frame in every six or twelve (a job spread
 *   over frames, a pass that runs every few): never SLOW_FRAMES slow ones in
 *   RECENT, and yet too long on average, for good. So the scale also steps down
 *   when the mean of the last WINDOW frames is over the target. Whether fewer
 *   pixels shorten such frames is not known beforehand: the step is a trial.
 *   If the ordinary frame (the median of the next WINDOW frames) is not shorter
 *   by GAIN, the time is not in the pixels (a heap collected over and over,
 *   tiles building under a frame cap): the step is taken back and tried again
 *   after PROBE_RETRY_MS, twice as long after each further time. The median,
 *   not the mean: how many long frames fall into a window is chance, and the
 *   window that set the trial off had more than most.
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
 *   PROBE_MS. A scale fails if a probe to it pushes the ordinary frame time
 *   (the median of PROBE_FRAMES frames, or PROBE_SLOW_FRAMES slow ones) over the
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
/** The scale steps down only if this many of the last RECENT frames were over the target. */
const SLOW_FRAMES = 3;
const RECENT = 12;
/** Frames whose mean frame time also steps the scale down, when it is over the target. */
const WINDOW = 96;
/** A step down for that mean is kept only if it shortens the ordinary frame by this share. */
const GAIN = 0.03;
/** One step of the scale. */
const STEP = 0.05;
/** On target for this long (ms), the controller tries one step up. */
const PROBE_MS = 2000;
/** Wait before a scale that failed is tried again (ms): at first, and at most. */
const PROBE_RETRY_MS = 60_000;
const PROBE_RETRY_MOST_MS = 600_000;
/** A probe holds if the ordinary frame time (the median) stays under this share of the target. */
const ON_TARGET = 1.03;
/** Frames a probe is judged over: by their median, which a few long ones among them leave alone. */
const PROBE_FRAMES = 16;
/** A probe fails early at this many frames over SLOW targets. */
const PROBE_SLOW_FRAMES = 4;
/**
 * Frame time, in targets, up to which a scale is slightly too much. A step down from a
 * smoothed frame time under it marks the scale as failed; over it, something else is slow.
 */
const SLOW = 1.3;

export class RenderScaleController {
  /** Current scale relative to the device pixel ratio. */
  scale = 1;
  private average = 0;
  private frames = 0;
  private changedAt = -Infinity;
  /** The last RECENT frames, one bit each, the newest lowest: set where the frame was slow. */
  private recent = 0;
  /** The last WINDOW frame times (ms), counted since the last change. */
  private readonly window = new Float64Array(WINDOW);
  /**
   * The step down taken for the window's mean, until it is judged: the scale before it, and
   * the window's mean and median then (ms).
   */
  private trial: { from: number; mean: number; median: number } | null = null;
  /** After a trial that shortened nothing: when the next one may come, and the wait after it. */
  private trialAfter = -Infinity;
  private trialWaitMs = PROBE_RETRY_MS;
  /** The probe being judged: the scale before it, and the frames since (how many, how many slow). */
  private probe: { from: number; count: number; slow: number } | null = null;
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
    this.recent = ((this.recent << 1) | (ms > this.targetMs * 1.1 ? 1 : 0)) & ((1 << RECENT) - 1);
    const counted = this.frames - SETTLE_FRAMES;
    this.window[(counted - 1) % WINDOW] = ms;
    const windowFull = counted >= WINDOW;
    const probe = this.probe;
    if (probe !== null) {
      probe.count++;
      if (ms > this.targetMs * SLOW) probe.slow++;
      const judged = probe.count >= PROBE_FRAMES;
      // The probe's frames are the window's first: the scale changed when it began. Their
      // median, not their mean: two long frames among sixteen (tiles streaming in while the
      // scale climbs back) lifted the mean over the target on a display that holds every
      // frame on it, and the scale then waited a minute for nothing, a step at a time.
      const ordinary = judged ? medianOf(this.window.subarray(0, PROBE_FRAMES)) : 0;
      if (probe.slow >= PROBE_SLOW_FRAMES || ordinary > this.targetMs * ON_TARGET) {
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
    if (this.trial !== null && windowFull) {
      const trial = this.trial;
      this.trial = null;
      if (this.windowMedian() > trial.median * (1 - GAIN)) {
        // Fewer pixels shortened nothing: back, and not again for a while.
        this.trialAfter = nowMs + this.trialWaitMs;
        this.trialWaitMs = Math.min(PROBE_RETRY_MOST_MS, this.trialWaitMs * 2);
        this.scale = trial.from;
        this.restart(nowMs);
        return this.scale;
      }
      // It did: the scale above was too much, as after any small step down that stands.
      this.trialWaitMs = PROBE_RETRY_MS;
      if (trial.mean <= this.targetMs * SLOW) this.failed(trial.from);
    }
    if (this.suspect !== null && since >= PROBE_MS) {
      // One small step down was enough: the scale above was slightly too much.
      this.failed(this.suspect);
      this.suspect = null;
    }
    let next = this.scale;
    let probing = false;
    // What the step down answers: the smoothed frame time, or the mean of the window where
    // the long frames are too few among the last RECENT to count as a load.
    let load = this.average;
    let median = 0;
    let trying = false;
    let down = false;
    if (this.average > this.targetMs * 1.1 && since >= HOLD_DOWN_MS) {
      if (bitCount(this.recent) >= SLOW_FRAMES) {
        down = true;
      } else if (windowFull && nowMs >= this.trialAfter) {
        const mean = this.windowMean();
        if (mean > this.targetMs * 1.1) {
          down = true;
          trying = true;
          load = mean;
          median = this.windowMedian();
        }
      }
    }
    if (down) {
      const factor = Math.min(0.95, Math.max(0.6, Math.sqrt(this.targetMs / load)));
      next = this.scale * factor;
    } else if (this.average < this.targetMs * 0.7 && since >= HOLD_UP_MS) {
      next = this.scale * 1.1;
    } else if (
      this.scale < this.maxScale &&
      // Not before a trial is judged: the probe would pass between two long frames.
      this.trial === null &&
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
    this.trial = null;
    const from = this.scale;
    if (probing) {
      // The scale that once failed has held for the retry time: the load has gone.
      if (this.scale >= this.ceiling - STEP / 2) this.forget();
      this.probe = { from: this.scale, count: 0, slow: 0 };
    } else if (next < this.scale) {
      // Down by a little: this scale has failed, if the lower one then stands. The first of
      // several steps down counts (a load that rises slowly), a slow spell's steps do not.
      // A trial is judged by what it gains, not by whether it stands.
      if (!trying && load <= this.targetMs * SLOW) this.suspect = suspect ?? this.scale;
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
    if (trying) this.trial = { from, mean: load, median };
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
      this.trial = null;
      this.forget();
    }
    this.scale = next;
    // The measurement starts over, and a probe under way is judged by the frames from here.
    if (this.probe !== null) {
      this.probe.count = 0;
      this.probe.slow = 0;
    }
    this.restart(nowMs);
  }

  /**
   * The load has changed (another view, other quality settings): restarts the measurement
   * and drops what the probes have learned, so the scale finds its place anew.
   */
  reset(nowMs: number): void {
    this.probe = null;
    this.suspect = null;
    this.trial = null;
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
    this.trialAfter = -Infinity;
    this.trialWaitMs = PROBE_RETRY_MS;
  }

  /** The mean of the last WINDOW frame times (ms); only once that many were counted. */
  private windowMean(): number {
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) sum += this.window[i]!;
    return sum / WINDOW;
  }

  /** Their median (ms): the ordinary frame, whatever the long ones among them. */
  private windowMedian(): number {
    return medianOf(this.window);
  }

  private restart(nowMs: number): void {
    this.frames = 0;
    this.changedAt = nowMs;
    this.recent = 0;
  }
}

/** The median of an even number of frame times. */
function medianOf(times: Float64Array): number {
  const sorted = times.slice().sort();
  const half = sorted.length >> 1;
  return (sorted[half - 1]! + sorted[half]!) / 2;
}

/** The number of set bits in the low 16 bits of `x`. */
function bitCount(x: number): number {
  let n = 0;
  for (let v = x & 0xffff; v !== 0; v &= v - 1) n++;
  return n;
}
