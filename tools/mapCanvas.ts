/**
 * Drawing on the offline map layout of tools/maps.preview.ts: an
 * equirectangular map on top (SIZE × SIZE/2) and orthographic north and south
 * polar caps below. Points are unit directions; every primitive is drawn into
 * all views where it is visible.
 */
import type { Point } from '../src/worldgen/strategic/graph';

export type Rgb = [number, number, number];

export class MapCanvas {
  readonly half: number;

  constructor(
    readonly img: Uint8Array,
    readonly size: number,
  ) {
    this.half = size / 2;
  }

  /** Pixel positions of a direction in each view where it is visible. */
  project(p: Readonly<Point>): [number, number][] {
    const out: [number, number][] = [];
    const H = this.half;
    const lat = Math.asin(Math.max(-1, Math.min(1, p[1])));
    const lon = Math.atan2(p[0], p[2]);
    out.push([((lon + Math.PI) / (2 * Math.PI)) * this.size, ((Math.PI / 2 - lat) / Math.PI) * H]);
    if (p[1] >= 0) out.push([((p[0] + 1) / 2) * H, H + ((p[2] + 1) / 2) * H]);
    if (p[1] <= 0) out.push([H + ((-p[0] + 1) / 2) * H, H + ((p[2] + 1) / 2) * H]);
    return out;
  }

  pixel(x: number, y: number, rgb: Readonly<Rgb>, alpha = 1): void {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.size || yi >= this.size) return;
    const o = (yi * this.size + xi) * 3;
    for (let k = 0; k < 3; k++) {
      this.img[o + k] = Math.round(this.img[o + k]! * (1 - alpha) + rgb[k]! * 255 * alpha);
    }
  }

  dot(p: Readonly<Point>, radius: number, rgb: Readonly<Rgb>, alpha = 1): void {
    for (const [x, y] of this.project(p)) {
      const r = Math.ceil(radius);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= radius * radius) this.pixel(x + dx, y + dy, rgb, alpha);
        }
      }
    }
  }

  /** Square outline marker. */
  square(p: Readonly<Point>, half: number, rgb: Readonly<Rgb>): void {
    for (const [x, y] of this.project(p)) {
      for (let d = -half; d <= half; d++) {
        for (const w of [0, 1]) {
          this.pixel(x + d, y - half - w, rgb);
          this.pixel(x + d, y + half + w, rgb);
          this.pixel(x - half - w, y + d, rgb);
          this.pixel(x + half + w, y + d, rgb);
        }
      }
    }
  }

  /** Great-circle segment, densified to about half a pixel of the equirectangular map. */
  segment(a: Readonly<Point>, b: Readonly<Point>, width: number, rgb: Readonly<Rgb>): void {
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const angle = Math.acos(dot);
    const steps = Math.max(1, Math.ceil((angle / (2 * Math.PI)) * this.size * 2));
    const s = Math.sin(angle);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let p: Point;
      if (s < 1e-9) {
        p = [a[0], a[1], a[2]];
      } else {
        const wa = Math.sin((1 - t) * angle) / s;
        const wb = Math.sin(t * angle) / s;
        p = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
      }
      this.dot(p, width / 2, rgb);
    }
  }

  polyline(points: Float64Array, width: number, color: (i: number) => Readonly<Rgb>): void {
    const n = points.length / 3;
    for (let i = 1; i < n; i++) {
      this.segment(
        [points[i * 3 - 3]!, points[i * 3 - 2]!, points[i * 3 - 1]!],
        [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!],
        width,
        color(i),
      );
    }
  }

  /** Darkens and desaturates the whole image, so overlays stand out. */
  dim(factor: number): void {
    for (let i = 0; i < this.img.length; i += 3) {
      const g = (this.img[i]! + this.img[i + 1]! + this.img[i + 2]!) / 3;
      for (let k = 0; k < 3; k++) {
        this.img[i + k] = Math.round((0.5 * this.img[i + k]! + 0.5 * g) * factor);
      }
    }
  }
}
