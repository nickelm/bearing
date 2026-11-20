import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { cellHash, hashBits } from '../src/worldgen/canopy';
import {
  blockHash,
  buildable,
  foldGridAngle,
  isOpenGround,
  MAJOR_HALF,
  MINOR_HALF,
  SIDEWALK,
  townLocal,
  URBAN_HASH_Z,
  UrbanClass,
  urbanClassAt,
  urbanSpacing,
} from '../src/render/sim/infra/urbanPattern';
import type { UrbanInfo } from '../src/render/sim/infra/urbanPattern';

const info: UrbanInfo = { angle: 0.3, spacing: 100, seed: 1234 };
const at = (u: number, v: number) => {
  const c = Math.cos(info.angle);
  const s = Math.sin(info.angle);
  return [u * c - v * s, u * s + v * c] as const;
};

describe('urban ground pattern (decision 259)', () => {
  it('draws streets on the grid lines, majors wider, with sidewalks beside them', () => {
    // Line 0 is major, line 1 minor.
    expect(urbanClassAt(...at(MAJOR_HALF - 0.5, 50), 0.5, info)).toBe(UrbanClass.Street);
    expect(urbanClassAt(...at(MAJOR_HALF + 1, 50), 0.5, info)).toBe(UrbanClass.Sidewalk);
    expect(urbanClassAt(...at(100 + MINOR_HALF + 0.5, 50), 0.5, info)).toBe(UrbanClass.Sidewalk);
    expect(urbanClassAt(...at(100 + MINOR_HALF + SIDEWALK + 1, 50), 0.5, info)).not.toBe(
      UrbanClass.Sidewalk,
    );
  });

  it('hashes blocks with the canopy hash the shader shares', () => {
    expect(blockHash(-3, 7, 99)).toBe(hashBits(cellHash(-3, 7, URBAN_HASH_Z, 99), 4));
    const values = new Set<number>();
    for (let i = 0; i < 50; i++) values.add(blockHash(i, -i, 5));
    expect(values.size).toBeGreaterThan(40);
  });

  it('puts squares only in the core and industry on concrete or gravel', () => {
    let squares = 0;
    for (let i = 0; i < 400; i++) {
      const x = 50 + 100 * (i % 20);
      const y = 50 + 100 * Math.floor(i / 20);
      const k = urbanClassAt(...at(x, y), 0.8, info);
      if (k === UrbanClass.Square) squares++;
      const ind = urbanClassAt(...at(x, y), 0.8, info, true);
      expect([UrbanClass.Concrete, UrbanClass.Gravel]).toContain(ind);
    }
    expect(squares).toBe(0);
  });

  it('keeps buildings off streets and open ground', () => {
    expect(buildable(...at(MAJOR_HALF + 2, 50), 0.6, info, 7)).toBe(false);
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      const [x, y] = at(50 + 100 * (i % 10), 50 + 100 * Math.floor(i / 10));
      const b = buildable(x, y, 0.6, info, 7);
      if (b) ok++;
      if (b) expect(isOpenGround(urbanClassAt(x, y, 0.6, info))).toBe(false);
    }
    expect(ok).toBeGreaterThan(70);
  });

  it('measures local coordinates in meters east and north', () => {
    const c = new Vec3d(0.3, 0.5, 0.8).normalize();
    const R = 1e6;
    const [x0, y0] = townLocal(c, c, R);
    expect(Math.hypot(x0, y0)).toBe(0);
    const north = c.clone().cross(new Vec3d(0, 1, 0).cross(c).normalize());
    const d = c
      .clone()
      .addScaled(north, 500 / R)
      .normalize();
    const [x, y] = townLocal(c, d, R);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(y).toBeCloseTo(500, 0);
  });

  it('folds angles to a quarter turn and spaces cities tighter', () => {
    expect(foldGridAngle(-0.1)).toBeCloseTo(Math.PI / 2 - 0.1);
    expect(foldGridAngle(Math.PI + 0.2)).toBeCloseTo(0.2);
    expect(urbanSpacing(500_000)).toBeLessThan(urbanSpacing(2_000));
  });
});
