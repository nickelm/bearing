import { describe, expect, it } from 'vitest';
import { FLOWN_MAX_RATE, flightRateCap } from '../src/sim/clock';
import type { FlightCapInput } from '../src/sim/clock';

const cruise: FlightCapInput = {
  airborne: true,
  gearDown: false,
  heightAboveGround: 8000,
  targetDistance: 150_000,
  enemyDistance: Infinity,
};

describe('the flight cap', () => {
  it('allows 8× in cruise', () => {
    expect(flightRateCap(cruise)).toEqual({ rate: FLOWN_MAX_RATE, reason: null });
    expect(FLOWN_MAX_RATE).toBe(8);
  });

  it('cancels on any threat, near the target, low, with the gear down or on the ground', () => {
    const cases: [Partial<FlightCapInput>, string][] = [
      [{ enemyDistance: 100_000 }, 'enemy aircraft near'],
      [{ targetDistance: 30_000 }, 'in the target area'],
      [{ heightAboveGround: 150 }, 'low'],
      [{ gearDown: true }, 'gear down'],
      [{ airborne: false }, 'on the ground'],
    ];
    for (const [change, reason] of cases)
      expect(flightRateCap({ ...cruise, ...change })).toEqual({ rate: 1, reason });
  });
});
