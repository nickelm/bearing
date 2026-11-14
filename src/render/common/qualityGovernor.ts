/**
 * The performance governor of the atmospheric effects (decision 143). The
 * adaptive render scale (renderScale.ts) holds the frame time by drawing
 * fewer pixels, which blurs the ground as much as the sky. Clouds and fog are
 * soft by nature, so on a machine that struggles they give way first: the
 * governor counts steps down from full quality, and the app maps the steps to
 * settings (one level of the volumetric quality, then half the particles; see
 * ui/atmosphereSettings.ts).
 *
 * It looks at the render scale, not only at the frame time: while the scale
 * adapts, the frame time sits near the target whatever the machine, and it is
 * the scale that says how hard the machine is pressed.
 *
 * - **Down** one step when the machine has struggled for DOWN_DWELL without
 *   a break: the scale at or under STRUGGLE_SCALE with a frame time that
 *   keeps it there (a scale on its way back up after a slow spell, such as
 *   tiles building at the start of a flight, is no struggle: every rise of
 *   the scale starts the dwell anew), or, where the scale is fixed or already
 *   at its floor, the smoothed frame time over the target by OVER_BUDGET.
 * - **Up** one step when the machine has held the full resolution for a while
 *   without a break: the scale at its ceiling (or fixed) and the smoothed
 *   frame time under HEADROOM of the target for the up-dwell, or merely on
 *   the target (ON_TARGET) for PATIENCE up-dwells. The second way is needed
 *   because a display shows whole refresh periods: at 60 Hz a frame of 20 ms
 *   is measured as 33 ms, and where the browser caps the page at the target
 *   rate every frame is, so headroom often cannot be seen at all.
 * - A step up is kept only if the full resolution still holds: one that makes
 *   the render scale give way (or, at a fixed scale, leaves the frame time
 *   off the target) is taken back after MIN_DWELL.
 * - **No oscillation.** Between any two changes lie at least MIN_DWELL. A
 *   step up that is taken back within PROBATION was a mistake: the up-dwell
 *   of that step doubles each time (UP_DWELL to UP_DWELL_MOST) and returns
 *   to UP_DWELL once the step has lasted. So a machine that can hold the
 *   lower setting but not the higher one tries again ever more rarely.
 * - Frames right after a change are ignored (SETTLE): changing a setting
 *   compiles shaders, and that frame says nothing about the setting.
 *
 * The class knows no renderer and no clock of its own: the caller passes
 * each frame's time and the time now, so tests run it on made-up frames.
 */

/** Seconds a struggle must last before a step down (ms). */
export const DOWN_DWELL = 4000;
/** Least time between two changes (ms). */
export const MIN_DWELL = 5000;
/** Seconds of headroom before a step up, at first and at most (ms). */
export const UP_DWELL = 10_000;
export const UP_DWELL_MOST = 300_000;
/** A step up taken back within this time doubles the up-dwell (ms). */
export const PROBATION = 30_000;
/** Time after a change in which frames are not counted (ms). */
export const SETTLE = 1000;
/** Render scale at or under which the machine counts as struggling. */
export const STRUGGLE_SCALE = 0.75;
/** Smoothed frame time over the target that counts as over budget, where the scale cannot help. */
export const OVER_BUDGET = 1.15;
/** Smoothed frame time under this share of the target counts as headroom. */
export const HEADROOM = 0.6;
/** Smoothed frame time up to this share of the target counts as on target. */
export const ON_TARGET = 1.05;
/** Up-dwells the frame time must stay on target, without headroom, before a step up. */
export const PATIENCE = 6;
/**
 * Smoothed frame time under this share of the target lets the render scale
 * climb (renderScale.ts raises it under 0.7): a low scale is then on its way up.
 */
export const SCALE_RISES = 0.7;
/** Weight of a new frame in the smoothed frame time. */
const SMOOTHING = 0.05;
/** A frame longer than this many targets is a hitch, counted as this many. */
const HITCH = 4;

/** One frame, as the governor sees it. */
export interface GovernorFrame {
  /** The frame's time (ms). */
  frameMs: number;
  /** The time now (ms), on any steady clock. */
  nowMs: number;
  /** The frame time to hold (ms). */
  targetMs: number;
  /** The render scale now, and its floor and ceiling. */
  scale: number;
  minScale: number;
  maxScale: number;
  /** Whether the render scale adapts to the frame time (false: the user fixed it). */
  adaptive: boolean;
}

export class QualityGovernor {
  /** Steps down from full quality, 0..`steps`. */
  level = 0;
  /** Smoothed frame time (ms); 0 before the first counted frame. */
  average = 0;
  /** Headroom needed before a step up from each level (ms); index 0 is unused. */
  private readonly dwell: number[];
  private changedAt = -Infinity;
  /** Frames before this time are not counted. */
  private ignoreUntil = -Infinity;
  /** When the last step up was taken and from which level, while it is on probation. */
  private raised: { at: number; from: number } | null = null;
  private strugglingSince: number | null = null;
  private headroomSince: number | null = null;
  private onTargetSince: number | null = null;
  /** The render scale of the last counted frame. */
  private lastScale = 0;

  constructor(
    /** How many steps down there are. */
    readonly steps = 2,
  ) {
    this.dwell = new Array<number>(steps + 1).fill(UP_DWELL);
  }

  /** Headroom needed before the next step up from the current level (ms). */
  get upDwell(): number {
    return this.dwell[this.level]!;
  }

  /** Records a frame; returns the new level when it changed, else null. */
  record(f: GovernorFrame): number | null {
    if (f.nowMs < this.ignoreUntil) return null;
    const ms = Math.min(f.frameMs, HITCH * f.targetMs);
    this.average = this.average === 0 ? ms : this.average + (ms - this.average) * SMOOTHING;
    if (this.raised !== null && f.nowMs - this.raised.at >= PROBATION) {
      // The last step up has lasted: the machine holds this level.
      this.dwell[this.raised.from] = UP_DWELL;
      this.raised = null;
    }
    const edge = 1e-6;
    const scaleCanHelp = f.adaptive && f.scale > f.minScale + edge;
    const struggling = f.adaptive
      ? (f.scale <= STRUGGLE_SCALE + edge && this.average >= f.targetMs * SCALE_RISES) ||
        (!scaleCanHelp && this.average > f.targetMs * OVER_BUDGET)
      : this.average > f.targetMs * OVER_BUDGET;
    const fullScale = !f.adaptive || f.scale >= f.maxScale - edge;
    const headroom = fullScale && this.average < f.targetMs * HEADROOM;
    const onTarget = fullScale && this.average <= f.targetMs * ON_TARGET;
    // A scale that rises is on its way back up: the struggle, if it is one, starts anew.
    const rising = f.adaptive && f.scale > this.lastScale + edge;
    this.lastScale = f.scale;
    this.strugglingSince = struggling && !rising ? (this.strugglingSince ?? f.nowMs) : null;
    this.headroomSince = headroom ? (this.headroomSince ?? f.nowMs) : null;
    this.onTargetSince = onTarget ? (this.onTargetSince ?? f.nowMs) : null;
    const sinceChange = f.nowMs - this.changedAt;
    // The last step up cost the full resolution: it is taken back.
    const regret = this.raised !== null && !onTarget;
    if (
      this.level < this.steps &&
      sinceChange >= MIN_DWELL &&
      (regret || (this.strugglingSince !== null && f.nowMs - this.strugglingSince >= DOWN_DWELL))
    ) {
      if (this.raised !== null) {
        // The step up did not hold: wait twice as long before taking it again.
        const from = this.raised.from;
        this.dwell[from] = Math.min(UP_DWELL_MOST, this.dwell[from]! * 2);
        this.raised = null;
      }
      return this.change(this.level + 1, f.nowMs);
    }
    if (
      this.level > 0 &&
      sinceChange >= MIN_DWELL &&
      ((this.headroomSince !== null && f.nowMs - this.headroomSince >= this.upDwell) ||
        (this.onTargetSince !== null && f.nowMs - this.onTargetSince >= this.upDwell * PATIENCE))
    ) {
      this.raised = { at: f.nowMs, from: this.level };
      return this.change(this.level - 1, f.nowMs);
    }
    return null;
  }

  /**
   * Starts the measurement over without changing the level: after the view
   * changed or was not drawn for a while, whose frames say nothing.
   */
  hold(nowMs: number): void {
    this.average = 0;
    this.strugglingSince = null;
    this.headroomSince = null;
    this.onTargetSince = null;
    this.ignoreUntil = nowMs + SETTLE;
  }

  /** Back to full quality with nothing remembered (the automatic was switched on again). */
  reset(nowMs: number): void {
    this.level = 0;
    this.dwell.fill(UP_DWELL);
    this.raised = null;
    this.average = 0;
    this.strugglingSince = null;
    this.headroomSince = null;
    this.onTargetSince = null;
    this.changedAt = nowMs;
    this.ignoreUntil = nowMs + SETTLE;
  }

  private change(level: number, nowMs: number): number {
    this.level = level;
    this.changedAt = nowMs;
    this.ignoreUntil = nowMs + SETTLE;
    this.average = 0;
    this.strugglingSince = null;
    this.headroomSince = null;
    this.onTargetSince = null;
    return level;
  }
}
