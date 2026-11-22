/**
 * The effects' hookups to the game (decision 329): weapons' trails from the stores catalog,
 * burning columns from target damage, and an aircraft's contrails, vortices and damage smoke.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { fireColumns } from '../src/render/sim/effects/columns';
import { EffectsSystem } from '../src/render/sim/effects/effectsSystem';
import { trailOf } from '../src/render/sim/effects/weapons';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import { STORES } from '../src/sim/air/stores';

const R = 1_000_000;

describe('weapons in the effects', () => {
  it('trail by the motor smoke the stores catalog names', () => {
    expect(trailOf('srm')).toBe('reduced-smoke');
    expect(trailOf('srm-p')).toBe('solid');
    expect(trailOf('rocket')).toBe('solid');
    expect(trailOf('bomb-230')).toBe('none');
    expect(trailOf('alliance-fighter')).toBe('wreck');
  });

  it('every missile and rocket pod names its motor smoke', () => {
    for (const s of Object.values(STORES))
      if (s.kind.endsWith('missile') || s.kind === 'rockets') expect(s.smoke, s.id).not.toBeNull();
  });
});

describe('burning columns from target damage', () => {
  const site = (id: number, kind: string, settlement = -1) => ({
    id,
    kind,
    point: [0, 1, 0] as const,
    settlement,
  });
  const sites = [
    site(0, 'fuel-depot'),
    site(1, 'factory'),
    site(2, 'bridge'),
    site(3, 'factory', 7),
    site(4, 'rail-yard'),
  ];

  it('burns damaged targets out of town, fuel as fuel fires, harder with more damage', () => {
    const cols = fireColumns(
      sites,
      new Map([
        [0, 0.8],
        [1, 0.3],
        [2, 1],
        [3, 0.9],
        [4, 0.05],
      ]),
      R,
    );
    expect(cols.map((c) => c.key)).toEqual(['site:0', 'site:1']);
    expect(cols[0]!.kind).toBe('fuel');
    expect(cols[1]!.kind).toBe('target');
    expect(cols[0]!.intensity).toBeGreaterThan(cols[1]!.intensity);
    expect(cols[0]!.at).toEqual([0, R, 0]);
  });
});

describe('an aircraft in the effects', () => {
  const fx = new EffectsSystem(new PlanetLighting(R), R);
  const pose = (alt: number, load: number, damage = 0) => ({
    pos: new Vec3d(0, R + alt, 0),
    vel: new Vec3d(250, 0, 0),
    forward: new Vec3d(1, 0, 0),
    right: new Vec3d(0, 0, 1),
    load,
    span: 10,
    length: 16,
    damage,
  });
  const points = (key: string, alt: number, load: number) => {
    fx.ribbons.clear();
    for (let i = 0; i < 20; i++) {
      const p = pose(alt, load);
      (p.pos as Vec3d).x = i * 25;
      fx.aircraft(key, p);
    }
    fx.ribbons.update(fx.time, new Vec3d(0, R + alt, -2000));
    return fx.ribbons.points;
  };

  it('leaves contrails only above the contrail altitude, vortices only in a hard pull', () => {
    fx.air.temperature = 15;
    fx.air.humidity = 0.4;
    expect(points('a', 10_000, 1)).toBeGreaterThan(0);
    expect(points('b', 3_000, 1)).toBe(0);
    expect(points('c', 3_000, 7)).toBeGreaterThan(0);
  });

  it('smokes when damaged, not when whole or shot down', () => {
    const before = fx.emitterCount;
    fx.aircraft('whole', pose(1000, 1, 0));
    fx.aircraft('dead', pose(1000, 1, 1));
    expect(fx.emitterCount).toBe(before);
    fx.aircraft('hit', pose(1000, 1, 0.3));
    expect(fx.emitterCount).toBe(before + 1);
  });
});
