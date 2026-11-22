/**
 * Damage to target sites and bridges (roadmap R1.8): what strikes change and
 * what the ATO's revisions, supply and movement read (R2.1–R2.3). Saved with
 * the campaign state (R1.2).
 *
 * Damage is a fraction 0..1 per target site (CampaignInput.targets id). Hits
 * combine as independent chances, 1 − (1 − a)(1 − b), so repeated strikes
 * approach destruction without passing it. A bridge target at BRIDGE_CUT or
 * more cuts its bridge in the network graph. Repair (R5) will lower damage
 * over time.
 */
import type { TargetSite } from '../../worldgen/strategic/infrastructure';
import type { Stateful } from '../simulation';
import type { StateHasher } from '../stateHash';
import type { NetworkInput } from './network';

/** Damage at which a bridge no longer carries traffic. */
export const BRIDGE_CUT = 0.5;

/** An attack on troops at the front (R2.2's CAS): what R2.3's ground war reads. */
export interface GroundAttack {
  time: number;
  side: string;
  theater: number;
  point: [number, number, number];
  amount: number;
}

export class DamageState implements Stateful {
  private readonly level = new Map<number, number>();
  /** Damage of road graph edges (R2.2's road interdiction), 0..1, combined as for sites. */
  private readonly roads = new Map<number, number>();
  /** Attacks on troops at the front, in time order (R2.2; R2.3 applies them). */
  attacks: GroundAttack[] = [];
  /** Counts changes to the sites' and roads' damage, for the main thread's copy (not state). */
  revision = 0;

  constructor(private readonly targets: readonly TargetSite[]) {}

  /** Damage of target `id`, 0 when untouched. */
  damage(id: number): number {
    return this.level.get(id) ?? 0;
  }

  /** Applies a hit of `amount` (0..1) to target `id` and returns its new damage. */
  hit(id: number, amount: number): number {
    if (!this.targets[id]) throw new RangeError(`No target ${id}`);
    const a = Math.min(1, Math.max(0, amount));
    const d = 1 - (1 - this.damage(id)) * (1 - a);
    if (d > 0) this.level.set(id, d);
    if (a > 0) this.revision++;
    return d;
  }

  /** Damage of road edge `e`, 0 when untouched. */
  roadDamage(e: number): number {
    return this.roads.get(e) ?? 0;
  }

  /** Applies a hit to road edge `e` and returns its new damage. */
  hitRoad(e: number, amount: number): number {
    const a = Math.min(1, Math.max(0, amount));
    const d = 1 - (1 - this.roadDamage(e)) * (1 - a);
    if (d > 0) this.roads.set(e, d);
    if (a > 0) this.revision++;
    return d;
  }

  /** Damaged road edges, in edge order. */
  damagedRoads(): { edge: number; damage: number }[] {
    return [...this.roads].sort((a, b) => a[0] - b[0]).map(([edge, damage]) => ({ edge, damage }));
  }

  /** Targets with any damage, in id order. */
  damaged(): { id: number; damage: number }[] {
    return [...this.level].sort((a, b) => a[0] - b[0]).map(([id, damage]) => ({ id, damage }));
  }

  /**
   * The bridges of `network` that are cut, as indices into its bridge arrays.
   * `lists` names the source list of each of the network's bridge sources, in
   * the order its builder took them (e.g. ['road', 'spur']).
   */
  cutBridges(network: NetworkInput, lists: readonly ('road' | 'rail' | 'spur')[]): Set<number> {
    const out = new Set<number>();
    for (const [id, d] of this.level) {
      const ref = this.targets[id]?.bridge;
      if (!ref || d < BRIDGE_CUT) continue;
      const source = lists.indexOf(ref.list);
      if (source < 0) continue;
      for (let b = 0; b < network.bridgeNode.length; b++) {
        if (network.bridgeSource[b] === source && network.bridgeIndex[b] === ref.index) out.add(b);
      }
    }
    return out;
  }

  save(): { sites: [number, number][]; roads: [number, number][]; attacks: GroundAttack[] } {
    return {
      sites: [...this.level].sort((a, b) => a[0] - b[0]),
      roads: [...this.roads].sort((a, b) => a[0] - b[0]),
      attacks: this.attacks.map((a) => ({ ...a, point: [...a.point] })),
    };
  }

  load(state: unknown): void {
    const s = state as ReturnType<DamageState['save']>;
    this.level.clear();
    this.roads.clear();
    for (const [id, d] of s.sites) this.level.set(id, d);
    for (const [e, d] of s.roads) this.roads.set(e, d);
    this.attacks = s.attacks.map((a) => ({ ...a, point: [...a.point] }));
  }

  hash(h: StateHasher): void {
    const s = this.save();
    h.number(s.sites.length);
    for (const [id, d] of s.sites) h.number(id).number(d);
    h.number(s.roads.length);
    for (const [e, d] of s.roads) h.number(e).number(d);
    h.number(s.attacks.length);
    for (const a of s.attacks) h.number(a.time).number(a.theater).number(a.amount);
  }
}
