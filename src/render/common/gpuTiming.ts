/**
 * GPU timing from timestamp queries (roadmap R1.1), behind `?dev&gputime=1`:
 * the renderer is created with `trackTimestamp`, and every frame resolves its
 * render and compute timestamps. Three keys a pass as `r:<call>:<context>:f<frame>`,
 * so passes are told apart by their place in the frame (the n-th render call),
 * not by name. Averages per view and pass go to the console every few seconds
 * and to `window.bearing.gpuTiming` for tools (browser.smoke.mjs records them).
 *
 * Needs the adapter's `timestamp-query` feature; without it `supported` is false
 * and nothing is measured.
 */
import type { WebGPURenderer } from 'three/webgpu';

/** Mean GPU milliseconds per frame in one view, in all and per render call. */
export interface GpuTimingView {
  frames: number;
  renderMs: number;
  computeMs: number;
  /** Render call index in the frame → mean ms. */
  passes: Record<number, number>;
}

interface Pool {
  timestamps: Map<string, number>;
}

/** Seconds between console reports. */
const REPORT_S = 5;

export class GpuTiming {
  readonly views: Record<string, GpuTimingView> = {};
  private pending = false;
  private lastReport = 0;

  constructor(private readonly renderer: WebGPURenderer) {}

  /** Whether the device can time passes (after `renderer.init()`). */
  get supported(): boolean {
    return (
      (this.renderer.backend as unknown as { trackTimestamp?: boolean }).trackTimestamp === true
    );
  }

  /** Call once per frame after rendering, with the view shown. */
  frame(view: string, nowMs: number): void {
    if (!this.supported || this.pending) return;
    this.pending = true;
    void Promise.all([
      this.renderer.resolveTimestampsAsync('render'),
      this.renderer.resolveTimestampsAsync('compute'),
    ])
      .then(([render, compute]) => {
        const v = (this.views[view] ??= { frames: 0, renderMs: 0, computeMs: 0, passes: {} });
        const n = v.frames + 1;
        v.renderMs += ((render ?? 0) - v.renderMs) / n;
        v.computeMs += ((compute ?? 0) - v.computeMs) / n;
        for (const [call, ms] of this.lastFramePasses()) {
          v.passes[call] = (v.passes[call] ?? 0) + (ms - (v.passes[call] ?? 0)) / n;
        }
        v.frames = n;
        if (nowMs - this.lastReport > REPORT_S * 1000) {
          this.lastReport = nowMs;
          console.info(`GPU ${view}: ${this.describe(view)}`);
        }
      })
      .finally(() => (this.pending = false));
  }

  /** "render 6.2 ms, compute 0.4 ms; passes 1: 3.1, 2: 1.0, …" for a view. */
  describe(view: string): string {
    const v = this.views[view];
    if (!v) return 'no frames';
    const passes = Object.entries(v.passes)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, ms]) => `${k}: ${ms.toFixed(2)}`)
      .join(', ');
    return `render ${v.renderMs.toFixed(2)} ms, compute ${v.computeMs.toFixed(2)} ms over ${v.frames} frames; passes ${passes}`;
  }

  /** Durations of the last resolved frame's render calls, by call index. */
  private lastFramePasses(): [number, number][] {
    const pools = (
      this.renderer.backend as unknown as { timestampQueryPool?: Record<string, Pool> }
    ).timestampQueryPool;
    const pool = pools?.render;
    if (!pool) return [];
    let last = -1;
    const parsed: { call: number; frame: number; ms: number }[] = [];
    for (const [uid, ms] of pool.timestamps) {
      const m = /^r:(\d+):[^:]+:f(\d+)$/.exec(uid);
      if (!m) continue;
      const frame = Number(m[2]);
      last = Math.max(last, frame);
      parsed.push({ call: Number(m[1]), frame, ms });
    }
    return parsed.filter((p) => p.frame === last).map((p) => [p.call, p.ms]);
  }
}
