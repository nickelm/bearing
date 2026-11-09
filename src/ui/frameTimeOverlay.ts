/**
 * Frame-time overlay: rolling average and worst frame time over the last N
 * frames, updated a few times per second so it stays readable.
 */
export class FrameTimeOverlay {
  private readonly el: HTMLDivElement;
  private readonly samples: Float64Array;
  private index = 0;
  private filled = 0;
  private lastTextUpdate = 0;

  constructor(
    parent: HTMLElement = document.body,
    windowSize = 120,
    private readonly textIntervalMs = 250,
  ) {
    this.samples = new Float64Array(windowSize);
    this.el = document.createElement('div');
    this.el.className = 'frame-overlay';
    this.el.textContent = 'frame —';
    parent.appendChild(this.el);
  }

  /** Records one frame's duration in milliseconds. */
  record(frameMs: number, nowMs: number): void {
    this.samples[this.index] = frameMs;
    this.index = (this.index + 1) % this.samples.length;
    this.filled = Math.min(this.filled + 1, this.samples.length);
    if (nowMs - this.lastTextUpdate >= this.textIntervalMs) {
      this.lastTextUpdate = nowMs;
      this.el.textContent = this.format();
    }
  }

  private format(): string {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < this.filled; i++) {
      const s = this.samples[i]!;
      sum += s;
      if (s > max) max = s;
    }
    const avg = sum / Math.max(1, this.filled);
    const fps = avg > 0 ? 1000 / avg : 0;
    return `frame ${avg.toFixed(2)} ms avg · ${max.toFixed(2)} ms max · ${fps.toFixed(0)} fps`;
  }

  dispose(): void {
    this.el.remove();
  }
}
