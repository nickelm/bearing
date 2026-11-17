/**
 * The mouse's control cursor (decision 198): where the player's mouse holds the
 * stick or the aim. It is a game control, not part of the aircraft's HUD, so it
 * draws in its own color, a soft magenta that diverges from the HUD's green
 * under every color-vision deficiency (Part I, *HUD and Displays*).
 *
 * - **Direct:** a faint mark at the screen's center, the stick's full-deflection
 *   box around it, a line from the center to the cursor, and a cross at the
 *   cursor: the line's length is how hard the stick is held.
 * - **Mouse aim:** a ring where the jet flies, projected from its direction in
 *   the world, so it stays put when the camera looks around.
 *
 * While the mouse is free (cursor mode), the cursor dims: what it shows still
 * holds, but the mouse is not moving it.
 */
import type { Projector } from './hud';

/** The control cursor's color and its halo. */
export const CONTROL_COLOR = '#FF8AE2';
const CONTROL_HALO = 'rgba(30, 0, 24, 0.7)';

export interface ControlCursor {
  kind: 'aim' | 'stick';
  /** Direct: the cursor in normalized device coordinates (−1..1, y up). */
  x: number;
  y: number;
  /** Mouse aim: the direction the jet flies toward (world, unit). */
  dir: [number, number, number] | null;
  /** The mouse is captured and moves the cursor. */
  active: boolean;
  /** Direct: full deflection and the dead zone, as offsets from the center (NDC). */
  full: number;
  deadzone: number;
}

/** Draws `cur` on a 2D context of `W` × `H` CSS px; `s` is the HUD's scale. */
export function drawControlCursor(
  c: CanvasRenderingContext2D,
  cur: ControlCursor,
  project: Projector,
  W: number,
  H: number,
  s: number,
): void {
  c.save();
  c.globalAlpha = cur.active ? 1 : 0.45;
  c.lineCap = 'round';
  const stroke = (path: () => void, width = 1.6, alpha = 1) => {
    c.globalAlpha = (cur.active ? 1 : 0.45) * alpha;
    c.strokeStyle = CONTROL_HALO;
    c.lineWidth = width + 2.4;
    c.beginPath();
    path();
    c.stroke();
    c.strokeStyle = CONTROL_COLOR;
    c.lineWidth = width;
    c.beginPath();
    path();
    c.stroke();
  };
  const toPx = (x: number, y: number) => ({ x: ((x + 1) / 2) * W, y: ((1 - y) / 2) * H });
  if (cur.kind === 'stick') {
    const o = toPx(0, 0);
    const p = toPx(cur.x, cur.y);
    const fx = (cur.full / 2) * W;
    const fy = (cur.full / 2) * H;
    // The full-deflection box and the dead zone, faint.
    stroke(() => c.rect(o.x - fx, o.y - fy, 2 * fx, 2 * fy), 1, 0.25);
    stroke(
      () => c.arc(o.x, o.y, Math.max(3, cur.deadzone * cur.full * W * 0.5), 0, 2 * Math.PI),
      1,
      0.5,
    );
    // The vector from the center to the cursor.
    if (Math.hypot(p.x - o.x, p.y - o.y) > 2) {
      stroke(
        () => {
          c.moveTo(o.x, o.y);
          c.lineTo(p.x, p.y);
        },
        1.4,
        0.7,
      );
    }
    stroke(() => {
      c.moveTo(p.x - 8 * s, p.y);
      c.lineTo(p.x + 8 * s, p.y);
      c.moveTo(p.x, p.y - 8 * s);
      c.lineTo(p.x, p.y + 8 * s);
    }, 2);
  } else if (cur.dir) {
    const p = project(cur.dir[0], cur.dir[1], cur.dir[2], false);
    if (p) {
      stroke(() => c.arc(p.x, p.y, 11 * s, 0, 2 * Math.PI), 2);
      stroke(() => {
        c.moveTo(p.x - 4 * s, p.y);
        c.lineTo(p.x + 4 * s, p.y);
      }, 2);
    }
  }
  c.restore();
}
