/**
 * Doctrine for the air tasking order (design, "Air Tasking"; roadmap R2.1): how
 * each side spreads its missions over a day and how often it revises its order.
 *
 * - **Alliance:** missions spread evenly through their window, each nudged by
 *   up to a third of its share of the window; the order is revised every
 *   two hours (decentralized command, more autonomy).
 * - **Pact:** strikes go in waves with a common time on target, every
 *   WAVE_PERIOD from an hour into the window, each within WAVE_SPREAD of the
 *   wave's time; other missions spread as the Alliance's do. The order is
 *   revised every four hours (centralized command).
 *
 * Both sides apportion their airborne aircraft between mission categories
 * (counter-air, support, strike, ground support, airlift), the Pact giving more
 * to strikes and ground support and less to support and airlift.
 *
 * The same code plans both sides; doctrine is these numbers. Draws come from
 * the caller's fork (per side, per day and per need), so a need's times are
 * the same at every revision of a day.
 */
import type { Side } from '../../campaign/cast';
import type { Rng } from '../../core/rng';
import { HOUR, MINUTE } from '../../core/units';
import type { GameTime } from '../../core/units';

/** Mission categories the apportionment shares the airborne aircraft between (a plug-in names its own). */
export type Category = 'counter-air' | 'support' | 'strike' | 'ground-support' | 'airlift';

export interface Doctrine {
  /** Hours between revisions of the day's order. */
  revisionHours: number;
  /** How strikes are timed: spread through the window, or in waves. */
  strikes: 'spread' | 'waves';
  /** Most aircraft of the side in the air at once (C2: 20–50 airborne in all). */
  maxAirborne: number;
  /**
   * Apportionment: the share of `maxAirborne` each category may fill. The shares
   * add up to more than 1, so a category may use what another leaves, but none
   * can take the whole sky because its needs rank first.
   */
  apportionment: Record<Category, number>;
}

export const DOCTRINE: Record<Side, Doctrine> = {
  alliance: {
    revisionHours: 2,
    strikes: 'spread',
    maxAirborne: 24,
    apportionment: {
      'counter-air': 0.5,
      support: 0.2,
      strike: 0.4,
      'ground-support': 0.4,
      airlift: 0.2,
    },
  },
  pact: {
    revisionHours: 4,
    strikes: 'waves',
    maxAirborne: 24,
    apportionment: {
      'counter-air': 0.5,
      support: 0.15,
      strike: 0.45,
      'ground-support': 0.45,
      airlift: 0.15,
    },
  },
};

export const WAVE_PERIOD = 3 * HOUR;
export const WAVE_SPREAD = 3 * MINUTE;

/** How a need's times on target are laid out. */
export type Timing = 'spread' | 'strike';

/**
 * `count` times on target in `window` for `side`: spread evenly (with jitter),
 * or, for a strike under wave doctrine, in waves.
 */
export function scheduleTimes(
  side: Side,
  timing: Timing,
  count: number,
  window: readonly [GameTime, GameTime],
  r: Rng,
): GameTime[] {
  const [a, b] = window;
  if (count <= 0 || !(b > a)) return [];
  const out: GameTime[] = [];
  if (timing === 'strike' && DOCTRINE[side].strikes === 'waves') {
    const waves: GameTime[] = [];
    for (let t = a + HOUR; t <= b; t += WAVE_PERIOD) waves.push(t);
    if (waves.length === 0) waves.push((a + b) / 2);
    for (let i = 0; i < count; i++) {
      const w = waves[i % waves.length]!;
      out.push(Math.min(b, Math.max(a, w + (r.nextFloat() - 0.5) * 2 * WAVE_SPREAD)));
    }
  } else {
    const share = (b - a) / count;
    for (let i = 0; i < count; i++) {
      out.push(a + (i + 0.5 + (r.nextFloat() - 0.5) * (2 / 3)) * share);
    }
  }
  return out.sort((x, y) => x - y);
}
