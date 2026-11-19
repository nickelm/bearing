/**
 * The planner's ledger (roadmap R2.1): which aircraft each squadron has
 * promised, and when, and how many of a side's aircraft will be in the air.
 *
 * A sortie holds its flight from its departure to its end plus the type's
 * turnaround; a squadron can promise a new sortie only if, at every moment of
 * it, the aircraft already promised plus the new flight fit within its
 * strength. Committed missions (in AirOps) count from now, as do aircraft in
 * turnaround. The airborne cap counts every flight's spans off the ground.
 *
 * The ledger is rebuilt at every revision from AirOps and the order, so it is
 * never saved.
 */
import type { Side } from '../../campaign/cast';
import type { GameTime } from '../../core/units';
import type { Route } from '../air/route';
import type { Category } from './doctrine';

interface Span {
  from: GameTime;
  to: GameTime;
  n: number;
}

/** Peak of the summed spans over [from, to). */
function peak(spans: readonly Span[], from: GameTime, to: GameTime): number {
  // The sum only rises where a span starts, so its peak is at `from` or at a start inside.
  const times = [from];
  for (const s of spans) if (s.from > from && s.from < to) times.push(s.from);
  let best = 0;
  for (const t of times) {
    let n = 0;
    for (const s of spans) if (s.from <= t && t < s.to) n += s.n;
    if (n > best) best = n;
  }
  return best;
}

/** Time spans a route spends in the air (between ground segments). */
export function airborneSpans(route: Route): [GameTime, GameTime][] {
  const spans: [GameTime, GameTime][] = [];
  for (const seg of route.segments) {
    if (seg.kind === 'ground') continue;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last[1] - seg.t0) < 1e-6) last[1] = seg.t1;
    else spans.push([seg.t0, seg.t1]);
  }
  return spans;
}

export class Ledger {
  private readonly squadrons = new Map<number, Span[]>();
  private readonly airborne: Record<Side, Span[]> = { alliance: [], pact: [] };
  private readonly byCategory = new Map<string, Span[]>();

  /** Promises `n` aircraft of squadron `sq` over [from, to). */
  hold(sq: number, from: GameTime, to: GameTime, n: number): void {
    let list = this.squadrons.get(sq);
    if (!list) this.squadrons.set(sq, (list = []));
    list.push({ from, to, n });
  }

  /** Counts `n` aircraft of `side` in the air along `route`, in a category. */
  fly(side: Side, route: Route, n: number, category: Category): void {
    let list = this.byCategory.get(`${side}:${category}`);
    if (!list) this.byCategory.set(`${side}:${category}`, (list = []));
    for (const [from, to] of airborneSpans(route)) {
      this.airborne[side].push({ from, to, n });
      list.push({ from, to, n });
    }
  }

  /** Whether squadron `sq` of `strength` aircraft can promise `n` more over [from, to). */
  fits(sq: number, strength: number, from: GameTime, to: GameTime, n: number): boolean {
    return peak(this.squadrons.get(sq) ?? [], from, to) + n <= strength;
  }

  /**
   * Whether `n` more aircraft of `side` along `route` stay within `cap`, and
   * within `categoryCap` of their category.
   */
  underCap(
    side: Side,
    route: Route,
    n: number,
    cap: number,
    category: Category,
    categoryCap: number,
  ): 'total' | 'category' | null {
    const list = this.byCategory.get(`${side}:${category}`) ?? [];
    for (const [from, to] of airborneSpans(route)) {
      if (peak(this.airborne[side], from, to) + n > cap) return 'total';
      if (peak(list, from, to) + n > categoryCap) return 'category';
    }
    return null;
  }
}
