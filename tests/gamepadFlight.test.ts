/**
 * A Free Flight takeoff, circuit and landing flown through a synthetic gamepad (Proposal
 * 0014): the scripted test pilot decides what it wants each step, and a "thumb" turns that
 * into stick deflections and button presses on a fake standard gamepad. Everything reaches
 * the flight model only through the input layer and `FlightInput`: the right stick (pitch,
 * roll), the left stick (rudder, the throttle as a rate with its detent and afterburner
 * hold, brakes at idle), ✕ for the gear, the parking brake released by the throttle push.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KNOT } from '../src/core/units';
import { AB_GATE, MIL_DETENT, neutralControls } from '../src/sim/flight/controlLaws';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import type { FlightEvent } from '../src/sim/flight/outcomes';
import { runwayEnds, TOUCHDOWN_ZONE } from '../src/sim/flight/runway';
import { spawnOnRunway } from '../src/sim/flight/spawn';
import { TestPilot } from '../src/sim/flight/testPilot';
import { FlightInput } from '../src/ui/flight/flightInput';
import { GamepadSource } from '../src/ui/input/gamepad';
import type { PadLike } from '../src/ui/input/gamepad';
import { InputLayer } from '../src/ui/input/layer';
import type { AxisId } from '../src/ui/input/profiles';
import { ProfileStore } from '../src/ui/input/profiles';
import { flatGround, kestrel, RADIUS, testRunway } from './helpers/flight';

class FakePad implements PadLike {
  id = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
  index = 0;
  connected = true;
  mapping = 'standard';
  axes = [0, 0, 0, 0];
  buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  set(i: number, on: boolean) {
    this.buttons[i] = { pressed: on, value: on ? 1 : 0 };
  }
}

describe('Free Flight by gamepad (Proposal 0014)', () => {
  beforeAll(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
  });
  afterAll(() => vi.unstubAllGlobals());

  it('takes off, flies the circuit and lands in the touchdown zone from pad inputs alone', () => {
    const runway = testRunway();
    const ground = flatGround(runway);
    const end = runwayEnds(runway)[0];
    const m = kestrel();
    spawnOnRunway(m, runway, end);
    const pad = new FakePad();
    const source = new GamepadSource(() => [pad]);
    const layer = new InputLayer(source, new ProfileStore(null));
    source.poll();
    const input = new FlightInput(new EventTarget() as unknown as HTMLElement, null, layer);
    input.maxLever = 1;
    input.reset(true);
    input.enabled = true;
    const messages: string[] = [];
    input.onMessage = (t) => messages.push(t);
    let gearPresses = 0;
    // As Free Flight does with the gear action.
    input.onAction = (a) => {
      if (a === 'gear') {
        gearPresses++;
        input.controls.gearDown = !input.controls.gearDown;
      }
    };

    /** The raw deflection of axis `i` that makes the layer read `target` for `id`. */
    const rawFor = (i: number, id: AxisId, target: number): number => {
      const keep = pad.axes[i]!;
      const f = (r: number) => {
        pad.axes[i] = r;
        return layer.axis(id);
      };
      const rising = f(1) > f(-1);
      let lo = -1;
      let hi = 1;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < target === rising) lo = mid;
        else hi = mid;
      }
      pad.axes[i] = keep;
      if (target === 0) return 0;
      return (lo + hi) / 2;
    };

    const pilot = new TestPilot(runway, end, RADIUS);
    const want = neutralControls();
    const monitor = new FlightMonitor([runway], RADIUS);
    const events: FlightEvent[] = [];
    let gearButton = false;
    let lastThrottle = 0;
    let lastV = 0;
    let maxLever = 0;
    let maxHeight = 0;
    let maxSpeed = 0;
    let parkingReleased = false;
    const legs = new Set<string>();

    const step = () => {
      Object.assign(want, input.controls);
      pilot.fly(m, want, FLIGHT_STEP);
      // Right stick: the pilot's stick.
      pad.axes[3] = rawFor(3, 'pitch', want.pitch);
      pad.axes[2] = rawFor(2, 'roll', want.roll);
      // Left stick, vertical: the throttle as a rate toward the lever the pilot wants.
      const lever = input.controls.throttle;
      let v = 0;
      const err = want.throttle - lever;
      if (want.brakeLeft > 0 && want.throttle <= 0) {
        // Brakes: idle, then the stick held back.
        v = lever > 0 ? -1 : -(0.3 + 0.7 * want.brakeLeft);
      } else if (want.throttle >= AB_GATE && lever >= MIL_DETENT - 1e-9 && lever < AB_GATE) {
        v = 1; // Push and hold through the afterburner gate.
      } else if (Math.abs(err) > 0.004) {
        v = Math.max(-1, Math.min(1, err * 8));
        if (Math.abs(v) < 0.05) v = 0.05 * Math.sign(v);
        // Stopped at military on the way down: let go for a moment, then pull again.
        if (lever === MIL_DETENT && v < 0 && lastV < 0 && lastThrottle === lever) v = 0;
      }
      lastV = v;
      lastThrottle = lever;
      pad.axes[1] = rawFor(1, 'throttle', Math.max(-1, Math.min(1, v)));
      // Left stick, horizontal: the rudder (guarded against the throttle's deflection).
      pad.axes[0] = rawFor(0, 'yaw', want.yaw);
      // ✕: the gear, one press per change.
      if (gearButton) gearButton = false;
      else if (want.gearDown !== input.controls.gearDown) gearButton = true;
      pad.set(0, gearButton);
      source.poll();
      input.update(FLIGHT_STEP);
      if (!input.controls.parkingBrake) parkingReleased = true;
      m.step(input.controls, ground);
      events.push(...monitor.update(m, FLIGHT_STEP));
      maxLever = Math.max(maxLever, input.controls.throttle);
      maxHeight = Math.max(maxHeight, m.telemetry.altitude - runway.elevation);
      maxSpeed = Math.max(maxSpeed, m.telemetry.cas);
      legs.add(pilot.legLabel);
    };

    for (let i = 0; i < 900 / FLIGHT_STEP && !m.crashed && pilot.phase !== 'stopped'; i++) step();
    for (let i = 0; i < 3 / FLIGHT_STEP && !m.crashed; i++) step();

    expect(m.crashed).toBeNull();
    expect(parkingReleased).toBe(true);
    expect(messages).toContain('Parking brake released');
    // The afterburner through the held push, and the gear up and down by ✕.
    expect(maxLever).toBeGreaterThanOrEqual(AB_GATE);
    expect(messages).toContain('Afterburner');
    expect(gearPresses).toBeGreaterThanOrEqual(2);
    expect(events.find((e) => e.kind === 'liftoff')).toBeDefined();
    expect(maxHeight).toBeGreaterThan(900);
    expect(maxSpeed / KNOT).toBeLessThan(340);
    for (const leg of ['upwind', 'downwind', 'final', 'flare', 'rollout'])
      expect(legs.has(leg), leg).toBe(true);
    const tds = events.filter((e) => e.kind === 'touchdown');
    expect(tds).toHaveLength(1);
    const td = tds[0]!.kind === 'touchdown' ? tds[0]!.touchdown : null;
    expect(td!.runway?.id).toBe(runway.id);
    expect(td!.sinkRate).toBeLessThan(2.5);
    expect(td!.inZone).toBe(true);
    expect(td!.distance!).toBeGreaterThan(TOUCHDOWN_ZONE[0]);
    expect(td!.distance!).toBeLessThan(TOUCHDOWN_ZONE[1]);
    expect(Math.abs(td!.offset!)).toBeLessThan(8);
    expect(pilot.phase).toBe('stopped');
    expect(events.some((e) => e.kind === 'stopped')).toBe(true);
    input.dispose();
  });
});
