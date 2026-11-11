import { describe, expect, it } from 'vitest';
import { CVD_MATRICES, DEFICIENCIES, simulateCvd } from '../tools/cvd';

describe('color-vision deficiency simulation', () => {
  it('keeps grays gray', () => {
    for (const kind of DEFICIENCIES) {
      for (const row of CVD_MATRICES[kind]) expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 2);
      const out = simulateCvd(Uint8Array.from([0, 0, 0, 128, 128, 128, 255, 255, 255]), kind);
      for (let i = 0; i < 9; i += 3) {
        expect(Math.abs(out[i]! - out[i + 1]!)).toBeLessThanOrEqual(2);
        expect(Math.abs(out[i + 1]! - out[i + 2]!)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('brings red and green together for deuteranopia, but keeps the factions apart', () => {
    const dist = (a: Uint8Array) => Math.hypot(a[0]! - a[3]!, a[1]! - a[4]!, a[2]! - a[5]!);
    const redGreen = Uint8Array.from([200, 60, 50, 60, 160, 60]);
    expect(dist(simulateCvd(redGreen, 'deuteranopia'))).toBeLessThan(dist(redGreen) / 2);
    // Part II faction colors: Alliance #2F6FB5, Pact #D0532B.
    const factions = Uint8Array.from([0x2f, 0x6f, 0xb5, 0xd0, 0x53, 0x2b]);
    for (const kind of DEFICIENCIES) expect(dist(simulateCvd(factions, kind))).toBeGreaterThan(80);
  });
});
