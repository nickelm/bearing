/**
 * Minimal mutable float64 3-vector for CPU-side world math.
 *
 * World positions live in planet-centered Cartesian meters and exceed float32
 * precision, so they must stay in `Vec3d` (JS numbers are float64) until the
 * renderer subtracts the camera position. Methods mutate `this` and return it
 * for chaining; use `clone()` when you need a copy.
 */
export class Vec3d {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: Readonly<Vec3d>): this {
    return this.set(v.x, v.y, v.z);
  }

  clone(): Vec3d {
    return new Vec3d(this.x, this.y, this.z);
  }

  add(v: Readonly<Vec3d>): this {
    return this.set(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: Readonly<Vec3d>): this {
    return this.set(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  /** this = a - b */
  subVectors(a: Readonly<Vec3d>, b: Readonly<Vec3d>): this {
    return this.set(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  scale(s: number): this {
    return this.set(this.x * s, this.y * s, this.z * s);
  }

  /** this += v * s */
  addScaled(v: Readonly<Vec3d>, s: number): this {
    return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s);
  }

  dot(v: Readonly<Vec3d>): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  /** this = this × v */
  cross(v: Readonly<Vec3d>): this {
    return this.set(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  /** Normalizes in place. A zero vector stays zero. */
  normalize(): this {
    const len = this.length();
    return len > 0 ? this.scale(1 / len) : this;
  }

  distanceTo(v: Readonly<Vec3d>): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  equals(v: Readonly<Vec3d>, eps = 0): boolean {
    return (
      Math.abs(this.x - v.x) <= eps &&
      Math.abs(this.y - v.y) <= eps &&
      Math.abs(this.z - v.z) <= eps
    );
  }
}
