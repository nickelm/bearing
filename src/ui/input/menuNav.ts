/**
 * Menus by gamepad (Proposal 0014, decision 367): the D-pad (or the left stick) moves a
 * visible focus over the controls of the open menu, ✕ / A presses, ○ / B goes back, and the
 * bumpers switch tabs or page through a list.
 *
 * - **Roots.** A menu registers its element with a priority; the highest-priority root that
 *   is visible has the gamepad. While one has it, `menuActive()` is true and the flight inputs
 *   and the displays leave the pad's buttons to it (the pause button still pauses).
 * - **Focus** moves spatially: to the nearest control in the pressed direction, weighting
 *   sideways offset twice. It is the browser's focus, so Enter and Space work too, with an
 *   amber ring while the pad drives it.
 * - **Pressing** clicks a button, a checkbox or a table row (a second press on a selected row
 *   double-clicks it: the start screen flies from its airbase). Left and right step a
 *   select's option or a slider's value instead of moving focus.
 * - **Back** calls the root's own back, or sends Escape, which closes every menu as the key does.
 */
import { inputLayer } from './layer';
import type { PadEvent } from './gamepad';

export interface NavRootOptions {
  /** Higher wins when several are visible. */
  priority: number;
  /** ○ / B; Escape when absent. */
  back?: () => void;
  /** The bumpers: −1 previous tab, +1 next; the list scrolls when absent. */
  tab?: (dir: 1 | -1) => void;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

const roots = new Map<HTMLElement, NavRootOptions>();

/** Registers a menu's root element; returns the unregister. */
export function registerNavRoot(el: HTMLElement, o: NavRootOptions): () => void {
  roots.set(el, o);
  return () => {
    roots.delete(el);
  };
}

function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (el.closest('[hidden]')) return false;
  if (el.getClientRects().length === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}

/** The root that has the gamepad now, or null. */
export function activeRoot(): [HTMLElement, NavRootOptions] | null {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
  let best: [HTMLElement, NavRootOptions] | null = null;
  for (const [el, o] of roots)
    if (visible(el) && (!best || o.priority > best[1].priority)) best = [el, o];
  return best;
}

/** Whether a menu has the gamepad (the flight inputs then leave its buttons alone). */
export function menuActive(): boolean {
  return activeRoot() !== null;
}

type Dir = 'up' | 'down' | 'left' | 'right';

const DIRS: Record<string, Dir> = {
  Pad12: 'up',
  Pad13: 'down',
  Pad14: 'left',
  Pad15: 'right',
  'Axis1-': 'up',
  'Axis1+': 'down',
  'Axis0-': 'left',
  'Axis0+': 'right',
};

/** The next control from `from` in direction `dir` among `list` (spatial navigation). */
export function nextInDirection(
  from: DOMRect | null,
  list: readonly { rect: DOMRect }[],
  dir: Dir,
): number {
  if (!from) return list.length > 0 ? 0 : -1;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = -1;
  let bestScore = Infinity;
  list.forEach(({ rect }, i) => {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    const side = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    if (along <= 1) return;
    const score = along + 2 * side;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

const REPEAT_DELAY = 380;
const REPEAT_EVERY = 110;

class MenuNav {
  private repeat: ReturnType<typeof setTimeout> | null = null;
  private style: HTMLStyleElement | null = null;

  constructor() {
    inputLayer().onRaw((e) => this.event(e));
    // The mouse takes over: the ring goes.
    document.addEventListener('pointermove', () => this.ring(null), { passive: true });
    this.style = document.createElement('style');
    this.style.textContent = `.pad-focus { outline: 2px solid #ffb347 !important; outline-offset: 1px; }
tr.pad-focus { outline-offset: -2px; }
.ff-card .ff-buttons.pad-row { flex-direction: row; flex-wrap: wrap; align-items: center; }
.pad-bindings table { width: 100%; border-collapse: collapse; }
.pad-bindings td { padding: 3px 6px 3px 0; vertical-align: top; }
.pad-bindings tr + tr td { border-top: 1px solid rgb(255 255 255 / 0.08); }`;
    document.head.append(this.style);
  }

  /** Returns true when the press was the menu's (the layer then starts no action from it). */
  private event(e: PadEvent): boolean {
    if (e.type !== 'press' && e.type !== 'release') return false;
    if (e.kind !== 'gamepad') return false;
    const dir = DIRS[e.code];
    if (e.type === 'release') {
      if (dir) this.stopRepeat();
      return false;
    }
    const root = activeRoot();
    if (!root) return false;
    if (dir) {
      this.move(root[0], dir);
      this.stopRepeat();
      this.repeat = setTimeout(() => {
        this.repeat = setInterval(() => {
          const r = activeRoot();
          if (r) this.move(r[0], dir);
        }, REPEAT_EVERY);
      }, REPEAT_DELAY);
      return true;
    }
    switch (e.code) {
      case 'Pad0':
        this.press(root[0]);
        return true;
      case 'Pad1':
        if (root[1].back) root[1].back();
        else escape();
        return true;
      case 'Pad4':
      case 'Pad5': {
        const d = e.code === 'Pad5' ? 1 : -1;
        if (root[1].tab) root[1].tab(d);
        else root[0].scrollBy({ top: d * root[0].clientHeight * 0.8 });
        return true;
      }
    }
    return false;
  }

  private stopRepeat(): void {
    if (this.repeat !== null) {
      clearTimeout(this.repeat);
      clearInterval(this.repeat);
    }
    this.repeat = null;
  }

  private controls(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  }

  private current(root: HTMLElement): HTMLElement | null {
    const a = document.activeElement;
    return a instanceof HTMLElement && root.contains(a) && a !== root ? a : null;
  }

  private move(root: HTMLElement, dir: Dir): void {
    const cur = this.current(root);
    // Left and right step a select or a slider in place.
    if (cur && (dir === 'left' || dir === 'right') && step(cur, dir === 'right' ? 1 : -1)) {
      this.ring(cur);
      return;
    }
    const list = this.controls(root).filter((el) => el !== cur);
    const i = nextInDirection(
      cur?.getBoundingClientRect() ?? null,
      list.map((el) => ({ rect: el.getBoundingClientRect() })),
      dir,
    );
    const next = list[i];
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.ring(next);
  }

  private press(root: HTMLElement): void {
    const cur = this.current(root) ?? this.controls(root)[0];
    if (!cur) return;
    this.ring(cur);
    if (cur instanceof HTMLTableRowElement && cur.classList.contains('selected')) {
      cur.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return;
    }
    if (cur instanceof HTMLSelectElement) {
      step(cur, 1);
      return;
    }
    cur.click();
    // A click can rebuild the menu (a row selected): keep the focus on its new self.
    if (!cur.isConnected) this.controls(root)[0]?.focus({ preventScroll: true });
  }

  private ringed: HTMLElement | null = null;

  private ring(el: HTMLElement | null): void {
    if (this.ringed === el) return;
    this.ringed?.classList.remove('pad-focus');
    this.ringed = el;
    el?.classList.add('pad-focus');
  }
}

/** Steps a select's option or a slider's value; false for any other control. */
function step(el: HTMLElement, d: 1 | -1): boolean {
  if (el instanceof HTMLSelectElement) {
    const n = el.options.length;
    if (n === 0) return true;
    el.selectedIndex = (el.selectedIndex + d + n) % n;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLInputElement && el.type === 'range') {
    if (d > 0) el.stepUp();
    else el.stepDown();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

/** An Escape press and release, as the key sends them. */
function escape(): void {
  for (const type of ['keydown', 'keyup'] as const)
    window.dispatchEvent(new KeyboardEvent(type, { code: 'Escape', key: 'Escape', bubbles: true }));
}

let nav: MenuNav | null = null;

/** Starts menu navigation by gamepad (once; needs a document). */
export function installMenuNav(): void {
  if (nav || typeof document === 'undefined' || typeof document.createElement !== 'function')
    return;
  nav = new MenuNav();
}
