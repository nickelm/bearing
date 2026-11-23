/**
 * Action resolution (Proposal 0014, decision 361): from code presses and releases to action
 * presses and releases, over a binding table `Record<Action, string[]>` of any device.
 *
 * - A chord (`Pad4&Pad12`) fires while its modifier is held, and then the plain binding of
 *   the same code (`Pad12`) does not: the chord wins.
 * - A release ends exactly the actions its press started, even when the modifier was let go
 *   first, so nothing stays held.
 * - An action is held while any of its presses is.
 */
import { parseBinding } from './codes';

export type BindingTable<A extends string = string> = Record<A, readonly string[]>;

export class ActionResolver<A extends string = string> {
  /** Plain bindings by code, and chords by code with their modifier. */
  private plain = new Map<string, A[]>();
  private chords = new Map<string, { modifier: string; action: A }[]>();
  /** Codes held, and the actions each held code's press started. */
  private readonly down = new Map<string, A[]>();

  constructor(table: BindingTable<A> = {} as BindingTable<A>) {
    this.setTable(table);
  }

  /** Replaces the table; held codes keep the actions they started. */
  setTable(table: BindingTable<A>): void {
    this.plain = new Map();
    this.chords = new Map();
    for (const [a, list] of Object.entries(table) as [A, readonly string[]][])
      for (const b of list) {
        const { modifier, code } = parseBinding(b);
        if (modifier) {
          const l = this.chords.get(code) ?? [];
          l.push({ modifier, action: a });
          this.chords.set(code, l);
        } else {
          const l = this.plain.get(code) ?? [];
          l.push(a);
          this.plain.set(code, l);
        }
      }
  }

  /** The actions a press of `code` would start now, given the codes held. */
  resolve(code: string): A[] {
    const chords = (this.chords.get(code) ?? []).filter((c) => this.down.has(c.modifier));
    if (chords.length > 0) return chords.map((c) => c.action);
    return [...(this.plain.get(code) ?? [])];
  }

  /** A code pressed: the actions it starts (none if it was already down). */
  press(code: string): A[] {
    if (this.down.has(code)) return [];
    const actions = this.resolve(code);
    this.down.set(code, actions);
    return actions;
  }

  /** A code released: the actions it ends. */
  release(code: string): A[] {
    const actions = this.down.get(code);
    if (!actions) return [];
    this.down.delete(code);
    return actions;
  }

  /** Whether `action` is held by any code. */
  held(action: A): boolean {
    for (const l of this.down.values()) if (l.includes(action)) return true;
    return false;
  }

  /** Whether a code is down (whatever it is bound to). */
  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Releases everything (focus lost, device gone); returns the actions ended. */
  clear(): A[] {
    const ended = [...this.down.values()].flat();
    this.down.clear();
    return ended;
  }

  /** Whether `code` is a modifier of some chord in the table. */
  isModifier(code: string): boolean {
    for (const l of this.chords.values()) if (l.some((c) => c.modifier === code)) return true;
    return false;
  }
}

/** Bindings of `table` that two actions share (for the bindings screen's warnings). */
export function conflicts<A extends string>(table: BindingTable<A>): Map<string, A[]> {
  const by = new Map<string, A[]>();
  for (const [a, list] of Object.entries(table) as [A, readonly string[]][])
    for (const b of list) by.set(b, [...(by.get(b) ?? []), a]);
  for (const [b, l] of by) if (l.length < 2) by.delete(b);
  return by;
}
