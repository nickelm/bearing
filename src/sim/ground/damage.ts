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

export class DamageState implements Stateful {
  private readonly level = new Map<number, number>();

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
    return d;
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

  save(): [number, number][] {
    return [...this.level].sort((a, b) => a[0] - b[0]);
  }

  load(state: unknown): void {
    this.level.clear();
    for (const [id, d] of state as [number, number][]) this.level.set(id, d);
  }

  hash(h: StateHasher): void {
    const s = this.save();
    h.number(s.length);
    for (const [id, d] of s) h.number(id).number(d);
  }
}
