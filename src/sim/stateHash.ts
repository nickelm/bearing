/**
 * Order-sensitive hash of simulation state for determinism checks: two runs
 * that reach the same game time must produce the same hash, whatever their
 * time acceleration. Numbers are hashed by their float64 bit patterns, so
 * any difference in the last bit shows.
 */
export class StateHasher {
  private a = 0x811c9dc5;
  private b = 0x01000193;
  private readonly view = new DataView(new ArrayBuffer(8));

  private byte(x: number): void {
    this.a = Math.imul(this.a ^ x, 0x01000193);
    this.b = Math.imul(this.b ^ x, 0x5bd1e995) ^ (this.b >>> 15);
  }

  number(x: number): this {
    this.view.setFloat64(0, x);
    for (let i = 0; i < 8; i++) this.byte(this.view.getUint8(i));
    return this;
  }

  string(s: string): this {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c & 255);
      this.byte(c >>> 8);
    }
    this.byte(0);
    return this;
  }

  floats(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) this.number(values[i]!);
    return this;
  }

  /** 16 hex digits. */
  digest(): string {
    const hex = (x: number) => (x >>> 0).toString(16).padStart(8, '0');
    return hex(this.a) + hex(this.b);
  }
}
