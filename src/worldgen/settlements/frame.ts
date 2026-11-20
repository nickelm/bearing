/**
 * A settlement's local frame (decision 260): the gnomonic projection about its
 * center, with east and north as `localFrame` in worldgen/edits/airfields.ts defines
 * them, so the terrain shader's urban ground can take the same coordinates
 * (x = R (p·e) / (p·c), y = R (p·n) / (p·c)).
 */
export class SettlementFrame {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly east: [number, number, number];
  readonly north: [number, number, number];

  constructor(
    center: readonly [number, number, number],
    readonly radius: number,
  ) {
    const l = Math.hypot(center[0], center[1], center[2]);
    this.cx = center[0] / l;
    this.cy = center[1] / l;
    this.cz = center[2] / l;
    // east = (0, 1, 0) × c
    let ex = this.cz;
    let ey = 0;
    let ez = -this.cx;
    let el = Math.hypot(ex, ey, ez);
    if (el < 1e-9) {
      ex = 1;
      ey = 0;
      ez = 0;
      el = 1;
    }
    ex /= el;
    ey /= el;
    ez /= el;
    this.east = [ex, ey, ez];
    // north = c × east
    this.north = [
      this.cy * ez - this.cz * ey,
      this.cz * ex - this.cx * ez,
      this.cx * ey - this.cy * ex,
    ];
  }

  /** Local (x, y) in meters of a direction (any length). */
  toPlane(x: number, y: number, z: number): [number, number] {
    const dc = x * this.cx + y * this.cy + z * this.cz;
    const k = this.radius / dc;
    return [
      k * (x * this.east[0] + y * this.east[1] + z * this.east[2]),
      k * (x * this.north[0] + y * this.north[1] + z * this.north[2]),
    ];
  }

  /** Unit direction of local (x, y). */
  toSphere(
    x: number,
    y: number,
    out: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    const R = this.radius;
    const dx = this.cx + (x * this.east[0] + y * this.north[0]) / R;
    const dy = this.cy + (x * this.east[1] + y * this.north[1]) / R;
    const dz = this.cz + (x * this.east[2] + y * this.north[2]) / R;
    const l = Math.hypot(dx, dy, dz);
    out[0] = dx / l;
    out[1] = dy / l;
    out[2] = dz / l;
    return out;
  }
}
