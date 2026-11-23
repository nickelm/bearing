/**
 * Flying the Pact's jets (roadmap R2.7): Free Flight's choice of them, the lever that ends at
 * military power without an afterburner, the HUD's metric units in the Pact's skin, and
 * the scripted traffic mirrored for a Pact player.
 */
import { describe, expect, it } from 'vitest';
import { KM, KMH, KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { buildTraffic } from '../src/freeflight/traffic';
import { parseFreeFlightUrl } from '../src/freeflight/url';
import { AVIONICS_PROFILES } from '../src/sim/avionics/profiles';
import { MIL_DETENT } from '../src/sim/flight/controlLaws';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import { spawnInAir } from '../src/sim/flight/spawn';
import { throttleStep } from '../src/ui/flight/flightInput';
import { HUD_UNITS } from '../src/ui/flight/hud';
import { wingtipOf } from '../src/render/sim/effects/aircraftPose';
import { modelSpec } from '../src/render/common/models/library';
import { bracketAlpha, BRACKET_ALPHA } from '../src/ui/flight/hudFrame';
import { isJet, JET_BUNDLES } from '../src/ui/flight/freeFlightMenu';
import { neutralControls } from '../src/sim/flight/controlLaws';
import { flatGround, flightModelOf, kestrelSpec, testRunway } from './helpers/flight';
import { runwayEnds } from '../src/sim/flight/runway';

describe('the Pact jets in Free Flight', () => {
  it('can be chosen by URL, and are jets with flight data and the Pact skin', () => {
    for (const id of ['vo31', 'vo35'] as const) {
      const { options } = parseFreeFlightUrl(new URLSearchParams(`aircraft=${id}`), '4');
      expect(options.aircraft).toBe(id);
      expect(isJet(id)).toBe(true);
      expect(AVIONICS_PROFILES[JET_BUNDLES[id]]!.skin).toBe('pact');
      expect(flightModelOf(JET_BUNDLES[id]).spec.mass.fuel).toBeGreaterThan(0);
    }
    expect(isJet('scout')).toBe(false);
  });

  it('end the lever at military power without an afterburner, and never light one', () => {
    let r = { lever: 0.7, stoppedAt: null as number | null };
    for (let i = 0; i < 20; i++) r = throttleStep(r.lever, 1, 0.05, null, MIL_DETENT);
    expect(r.lever).toBe(MIL_DETENT);
    // With one the lever goes on through the gate.
    expect(throttleStep(MIL_DETENT, 1, 0.05, null).lever).toBeGreaterThan(MIL_DETENT);
    const m = flightModelOf(JET_BUNDLES.vo35);
    const runway = testRunway();
    spawnInAir(m, runway, runwayEnds(runway)[0], 3000, 300 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = 1;
    for (let i = 0; i < 10 / FLIGHT_STEP; i++) m.step(ctl, flatGround(runway));
    expect(m.afterburner).toBe(0);
    expect(m.power).toBeGreaterThan(0.95);
  });

  it('centers the angle-of-attack bracket on each type’s on-speed angle', () => {
    expect(bracketAlpha(kestrelSpec())).toBe(BRACKET_ALPHA);
    const vo35 = flightModelOf(JET_BUNDLES.vo35).spec;
    expect(bracketAlpha(vo35).center).toBeCloseTo(vo35.controls.approachAlpha, 12);
    expect(bracketAlpha(vo35).top).toBeLessThan(bracketAlpha(vo35).center);
  });
});

describe('the HUD’s units', () => {
  it('keeps the Alliance’s knots, feet, nautical miles and pounds as they were', () => {
    const u = HUD_UNITS.imperial;
    expect(u.speed).toBe(KNOT);
    expect(u.climb(10.16)).toBe('+2,000 fpm');
    expect(u.climb(-1)).toBe('−200 fpm');
    expect(u.distance(18_520)).toBe('10 NM');
    expect(u.distance(9_260)).toBe('5.0 NM');
    expect(u.fuel(1000)).toBe('2,200 LB');
  });

  it('gives the Pact kilometers per hour, meters, meters per second, kilometers and kilograms', () => {
    const u = HUD_UNITS.metric;
    expect(u.speed).toBe(KMH);
    expect(u.altitude).toBe(1);
    expect(u.climb(12.4)).toBe('+12 m/s');
    expect(u.climb(-3.26)).toBe('−3.3 m/s');
    expect(u.distance(25 * KM)).toBe('25 KM');
    expect(u.distance(4_200)).toBe('4.2 KM');
    expect(u.fuel(3456)).toBe('3,460 KG');
  });
});

describe('Free Flight’s traffic for a Pact player', () => {
  const base = new Vec3d(0, 0, 1);
  it('flies the same circles with the other side’s types, the radars now the Alliance’s', () => {
    const a = buildTraffic(base, 'base-3', 1_000_000);
    const p = buildTraffic(base, 'base-3', 1_000_000, 'pact');
    expect(p.aircraft.map((x) => x.radius)).toEqual(a.aircraft.map((x) => x.radius));
    for (let i = 0; i < a.aircraft.length; i++)
      expect(p.aircraft[i]!.side).not.toBe(a.aircraft[i]!.side);
    expect(p.aircraft.filter((x) => x.side === 'alliance').map((x) => x.model)).toContain(
      'alliance-fighter',
    );
    expect(p.aircraft.filter((x) => x.side === 'pact').map((x) => x.model)).toEqual([
      'pact-fighter',
    ]);
    expect(p.sites.every((x) => x.side === 'alliance')).toBe(true);
  });
});

describe('the jets’ wingtip vortices (decision 319)', () => {
  it('shed at each model’s wingtip, three quarters back along its tip chord', () => {
    const tipOf = (id: string) => wingtipOf(modelSpec(id), flightModelOf(id).spec.cg)!;
    // The Kestrel: tip leading edge 1.76 m behind the model's origin, chord 1.1 m, CG at −0.4.
    const k = tipOf('alliance-fighter');
    expect(k[1]).toBeCloseTo(4.8, 6);
    expect(k[0]).toBeCloseTo(1.6 - 4 * Math.tan((40 * Math.PI) / 180) - 0.825 + 0.4, 6);
    // The Vo-31's tips are 5.7 m out and about 3 m behind its center of gravity.
    const v = tipOf('pact-fighter');
    expect(v[1]).toBeCloseTo(5.7, 6);
    expect(v[0]).toBeLessThan(-2.8);
    expect(v[0]).toBeGreaterThan(-3.6);
    // The A-15's main wing, not its drooped tip pieces.
    expect(tipOf('a15')[1]).toBeCloseTo(8.75, 2);
  });
});
