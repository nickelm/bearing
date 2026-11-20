/**
 * A small CPU rasterizer for settlement plans (decision 260): filled polygons and thick
 * lines into an RGB buffer, for `tools/cities.preview.ts`.
 */
export class Canvas {
  readonly rgb: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg = 0xf0ece4,
  ) {
    this.rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.rgb[i * 3] = (bg >> 16) & 255;
      this.rgb[i * 3 + 1] = (bg >> 8) & 255;
      this.rgb[i * 3 + 2] = bg & 255;
    }
  }

  /** Fills a polygon given in pixel coordinates (even-odd scanline). */
  fill(p: number[], color: number, alpha = 1): void {
    const n = p.length / 2;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      y0 = Math.min(y0, p[i * 2 + 1]!);
      y1 = Math.max(y1, p[i * 2 + 1]!);
    }
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    for (
      let y = Math.max(0, Math.ceil(y0 - 0.5));
      y <= Math.min(this.h - 1, Math.floor(y1 - 0.5));
      y++
    ) {
      const sy = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ya = p[i * 2 + 1]!;
        const yb = p[j * 2 + 1]!;
        if (ya > sy !== yb > sy)
          xs.push(p[i * 2]! + ((sy - ya) * (p[j * 2]! - p[i * 2]!)) / (yb - ya));
      }
      xs.sort((a, c) => a - c);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (
          let x = Math.max(0, Math.ceil(xs[k]! - 0.5));
          x <= Math.min(this.w - 1, Math.floor(xs[k + 1]! - 0.5));
          x++
        ) {
          const o = (y * this.w + x) * 3;
          this.rgb[o] = this.rgb[o]! * (1 - alpha) + r * alpha;
          this.rgb[o + 1] = this.rgb[o + 1]! * (1 - alpha) + g * alpha;
          this.rgb[o + 2] = this.rgb[o + 2]! * (1 - alpha) + b * alpha;
        }
      }
    }
  }

  line(ax: number, ay: number, bx: number, by: number, width: number, color: number): void {
    const dx = bx - ax;
    const dy = by - ay;
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * width * 0.5;
    const ny = (dx / l) * width * 0.5;
    this.fill([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny], color);
  }

  disk(x: number, y: number, r: number, color: number): void {
    const p: number[] = [];
    for (let k = 0; k < 16; k++)
      p.push(x + r * Math.cos((k / 16) * 2 * Math.PI), y + r * Math.sin((k / 16) * 2 * Math.PI));
    this.fill(p, color);
  }
}
