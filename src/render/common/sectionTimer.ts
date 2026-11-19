/**
 * CPU time per section of a frame (roadmap R1.1): `begin()` at the frame's
 * start, `lap(name)` after each section, `end()` when the frame is done. Means
 * and worst cases per section, over the frames since the last `reset()`. Off
 * unless `enabled`, when every call returns at once.
 *
 * The strategic map turns it on with `?dev&cputime=1` and logs it every few
 * seconds; tools/render.preview.ts prints it with `PERF=n`.
 */
export class SectionTimer {
  enabled = false;
  frames = 0;
  private readonly sum = new Map<string, number>();
  private readonly worst = new Map<string, number>();
  private readonly current = new Map<string, number>();
  private last = 0;

  begin(): void {
    if (!this.enabled) return;
    this.current.clear();
    this.last = performance.now();
  }

  lap(name: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    this.current.set(name, (this.current.get(name) ?? 0) + now - this.last);
    this.last = now;
  }

  end(): void {
    if (!this.enabled) return;
    this.frames++;
    for (const [k, ms] of this.current) {
      this.sum.set(k, (this.sum.get(k) ?? 0) + ms);
      this.worst.set(k, Math.max(this.worst.get(k) ?? 0, ms));
    }
  }

  reset(): void {
    this.frames = 0;
    this.sum.clear();
    this.worst.clear();
  }

  /** Mean and worst ms per section, largest mean first. */
  report(): { section: string; mean: number; worst: number }[] {
    return [...this.sum]
      .map(([section, s]) => ({
        section,
        mean: s / Math.max(1, this.frames),
        worst: this.worst.get(section) ?? 0,
      }))
      .sort((a, b) => b.mean - a.mean);
  }

  /** "labels 12.3 (40.1), relief 3.2 (5.0), …: mean (worst) ms over n frames". */
  describe(): string {
    const parts = this.report().map(
      (r) => `${r.section} ${r.mean.toFixed(2)} (${r.worst.toFixed(1)})`,
    );
    return `${parts.join(', ')}: mean (worst) ms over ${this.frames} frames`;
  }
}
