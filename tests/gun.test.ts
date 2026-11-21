/** The gun, its rounds and the lead-computing pipper (decision 295). */
import { describe, expect, it } from 'vitest';
import { Quatd } from '../src/core/quat';
import { Vec3d } from '../src/core/vec3d';
import { bundleOfType } from '../src/sim/air/bundles';
import { initialAvionics } from '../src/sim/avionics/avionics';
import { Gun, leadSolution, PIPPER_RANGE } from '../src/sim/flight/gun';
import type { GunSpec } from '../src/sim/flight/gun';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { StoresRack } from '../src/sim/flight/storesRack';
import { kestrelSpec } from './helpers/flight';
import { capMission, phaseStart, promote } from './helpers/promoted';

const R = 6_371_000;
const spec = bundleOfType('f21').gun!;
const cg = kestrelSpec().cg;
/** The muzzle at the CG, so the solution shows the rounds' fall alone. */
const atCg: GunSpec = { ...spec, at: [...cg] as [number, number, number] };

/** Level at 3 km, 200 m/s east-ish along +x, wings level: body x = world +x, body z = down. */
function shooter(pitchRate = 0) {
  const up = new Vec3d(0, 0, 1);
  return {
    pos: new Vec3d(0, 0, R + 3000),
    vel: new Vec3d(200, 0, 0),
    q: Quatd.fromAxes(new Vec3d(1, 0, 0), new Vec3d(0, -1, 0), up.clone().scale(-1)),
    omega: new Vec3d(0, pitchRate, 0),
  };
}

describe('the gun (decision 295)', () => {
  it('fires at its rate while the trigger is held and armed, a tracer in five', () => {
    const g = new Gun(spec);
    g.trigger = true;
    let fired = 0;
    for (let i = 0; i < 120; i++) fired += g.step(shooter(), cg, 1 / 120, R, true);
    expect(fired).toBe(100);
    expect(g.rounds).toBe(410);
    expect(g.live.filter((r) => r.tracer)).toHaveLength(20);
    const safe = new Gun(spec);
    safe.trigger = true;
    expect(safe.step(shooter(), cg, 0.5, R, false)).toBe(0);
  });

  it('flies its rounds out at the muzzle velocity plus the aircraft’s, slowing and falling', () => {
    const g = new Gun(atCg);
    g.trigger = true;
    g.step(shooter(), cg, 0.01, R, true);
    g.trigger = false;
    const r = g.live[0]!;
    expect(r.vel.x).toBeCloseTo(1230, -1);
    for (let i = 0; i < 100; i++) g.step(shooter(), cg, 0.01, R, true);
    expect(r.vel.x).toBeLessThan(1150);
    expect(r.pos.length() - R).toBeLessThan(3000);
  });

  it('puts the pipper below the boresight by the rounds’ fall in level flight', () => {
    const sol = leadSolution(shooter(), atCg, cg, R)!;
    expect(sol.tof).toBeGreaterThan(0.4);
    // 20 mm rounds lose about a third of their speed over a kilometer.
    expect(sol.tof).toBeLessThan(0.8);
    // About ½ g t² over the range: a couple of milliradians down.
    const down = sol.dir.z / sol.dir.x;
    expect(down).toBeGreaterThan(0.0005);
    expect(down).toBeLessThan(0.008);
    expect(Math.abs(sol.dir.y)).toBeLessThan(1e-6);
  });

  it('leads a pull: the pipper drops further below the nose as the turn tightens', () => {
    const level = leadSolution(shooter(), atCg, cg, R)!;
    const pull = leadSolution(shooter(0.2), atCg, cg, R)!;
    // 0.2 rad/s for about half a second: some 0.1 rad of lead below the level solution.
    expect(pull.dir.z / pull.dir.x - level.dir.z / level.dir.x).toBeGreaterThan(0.05);
    expect(leadSolution(shooter(), atCg, cg, R, 5000)).toBeNull();
    expect(PIPPER_RANGE).toBeGreaterThan(500);
  });

  it('fires from the rack only with master arm and the gun selected, and counts its rounds', () => {
    const m = capMission();
    const f = promote({ ...m, aircraft: 1 }, phaseStart(m, 'on-target') + 100);
    const a = f.aircraft[0]!;
    const model = a.flown.airframe as unknown as FlightModel;
    const rack = a.rack;
    rack.gun!.trigger = true;
    let av = initialAvionics(false);
    expect(rack.stepGun(model, av, 0.5)).toBe(0);
    av = { ...av, masterArm: true, weapon: 'gun' };
    expect(rack.stepGun(model, av, 0.5)).toBe(50);
    expect(rack.state.expended.gun).toBe(50);
    // Promoted again, it carries the rounds it has left.
    const again = new StoresRack(kestrelSpec(), null, undefined, rack.state, spec);
    expect(again.gun!.rounds).toBe(460);
  });
});

describe('tracers (decision 295)', () => {
  it('trail their rounds no further back than the rounds have flown from the gun', async () => {
    const { Tracers } = await import('../src/render/sim/aircraft/tracers');
    const { Matrix4, Vector3 } = await import('three/webgpu');
    const t = new Tracers();
    const round = (age: number) => ({
      pos: new Vec3d(age * 1230, 0, 0),
      vel: new Vec3d(1230, 0, 0),
      age,
      tracer: true,
    });
    t.place([round(1 / 60), round(1)], new Vec3d(), 0.001, spec.muzzleVelocity);
    const len = (i: number) => {
      const m = new Matrix4();
      t.mesh.getMatrixAt(i, m);
      return new Vector3().setFromMatrixColumn(m, 0).length();
    };
    // A round one frame out: a streak of what it flew, about 17 m, not the full 31 m.
    expect(len(0)).toBeCloseTo(spec.muzzleVelocity / 60, 3);
    expect(len(1)).toBeCloseTo(1230 * 0.025, 3);
    t.dispose();
  });
});
