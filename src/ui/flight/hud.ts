/**
 * The Free Flight HUD (decision 134; Proposal 0002, HUD and Displays; P2 extends
 * it): a Canvas 2D overlay at device pixel ratio over the chase view.
 *
 * - **World-anchored:** the flight path marker (the velocity projected at a great
 *   distance, so the camera's offset causes no parallax), the boresight cross,
 *   and the destination runway's outline and aim point.
 * - **Screen-anchored:** airspeed (KIAS, Mach below), altitude (barometric feet,
 *   radar altitude below 1,500 ft) and heading tapes, a compact attitude
 *   indicator instead of a pitch ladder, load factor, angle of attack with the
 *   approach indexer (13°), throttle and afterburner stage, fuel, and the gear,
 *   speedbrake and brake states.
 * - **Landing aid:** distance and bearing to the destination runway, and
 *   localizer and glideslope deviation bars for a 3° glide path.
 * - **Messages:** airborne, touchdown summaries, warnings, crash reasons.
 * - **Debug panel** (F3): α, β, CL, CD, thrust, load factor, body forces, timing.
 *
 * The F-21 is an Alliance aircraft, so the HUD reads knots and feet. One color,
 * green, with a thin dark halo, so it stays legible on bright sky and snow
 * (Part I, HUD and Displays; tuned in P2).
 */
import './flight.css';
import { DEG, FOOT, KNOT, NAUTICAL_MILE } from '../../core/units';
import type { FlightWarning } from '../../sim/flight/outcomes';

/** HUD green and its halo. */
export const HUD_COLOR = '#6CFF8A';
const HALO = 'rgba(0, 18, 6, 0.75)';
const WARN_COLOR = '#FFB347';

/** A world direction or camera-relative point projected to CSS pixels, or null if behind the camera. */
export type Projector = (
  x: number,
  y: number,
  z: number,
  point: boolean,
) => { x: number; y: number } | null;

export interface HudLandingAid {
  name: string;
  designator: string;
  /** Distance (m) and bearing (rad) to the threshold. */
  distance: number;
  bearing: number;
  /** Localizer and glideslope deviation in full-scale units (−1..1, + fly right / fly up). */
  localizer: number;
  glideslope: number;
  /** Runway outline corners and aim point, camera-relative (m). */
  corners: [number, number, number][];
  aim: [number, number, number];
}

export interface HudFrame {
  cas: number;
  mach: number;
  altitude: number;
  radarAltitude: number;
  verticalSpeed: number;
  heading: number;
  pitch: number;
  bank: number;
  alpha: number;
  beta: number;
  load: number;
  throttle: number;
  power: number;
  afterburner: number;
  fuel: number;
  unlimitedFuel: boolean;
  gear: number;
  gearDown: boolean;
  speedbrake: number;
  brakes: boolean;
  parkingBrake: boolean;
  onGround: boolean;
  /** Velocity and body-x directions (world, unit). */
  velocity: [number, number, number];
  boresight: [number, number, number];
  warnings: FlightWarning[];
  aid: HudLandingAid | null;
  /** Control mode label ("direct", "mouse stick", "mouse aim") and the aim point in NDC for mouse aim. */
  mode: string;
  aim: { x: number; y: number } | null;
  debug: {
    cl: number;
    cd: number;
    thrust: number;
    qbar: number;
    aero: [number, number, number];
    gear: [number, number, number];
    gravity: [number, number, number];
    blend: number;
    frameMs: number;
    physicsMs: number;
    steps: number;
  } | null;
}

/**
 * A projector from a camera's view and projection matrices (column-major, as
 * three.js stores them), for a viewport of `width` × `height` CSS pixels. The
 * camera sits at the origin (rule 4), so points are camera-relative; directions
 * are projected at 5 km, far enough that the camera's offset causes no parallax.
 */
export function matrixProjector(
  view: ArrayLike<number>,
  projection: ArrayLike<number>,
  width: number,
  height: number,
): Projector {
  const v = Array.from(view);
  const p = Array.from(projection);
  return (x, y, z, point) => {
    if (!point) {
      const n = Math.hypot(x, y, z) || 1;
      x = (x / n) * 5000;
      y = (y / n) * 5000;
      z = (z / n) * 5000;
    }
    const ex = v[0]! * x + v[4]! * y + v[8]! * z + v[12]!;
    const ey = v[1]! * x + v[5]! * y + v[9]! * z + v[13]!;
    const ez = v[2]! * x + v[6]! * y + v[10]! * z + v[14]!;
    if (ez > -0.1) return null;
    const cx = p[0]! * ex + p[4]! * ey + p[8]! * ez + p[12]!;
    const cy = p[1]! * ex + p[5]! * ey + p[9]! * ez + p[13]!;
    const cw = p[3]! * ex + p[7]! * ey + p[11]! * ez + p[15]!;
    return { x: ((cx / cw + 1) / 2) * width, y: ((1 - cy / cw) / 2) * height };
  };
}

interface Message {
  text: string[];
  until: number;
  warn: boolean;
}

const WARNING_TEXT: Record<FlightWarning, string> = {
  'gear-speed': 'GEAR SPEED LIMIT',
  stall: 'STALL',
  'pull-up': 'PULL UP',
  'tail-strike': 'PITCH — TAIL STRIKE',
};

export class Hud {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private messages: Message[] = [];
  private w = 1;
  private h = 1;
  private dpr = 1;
  visible = true;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ff-hud';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.hidden = true;
  }

  show(on: boolean): void {
    this.canvas.hidden = !on;
    if (!on) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Shows a message for `seconds` (real time). */
  message(text: string | string[], seconds = 4, warn = false): void {
    const lines = Array.isArray(text) ? text : [text];
    this.messages = this.messages.filter((m) => m.text.join() !== lines.join());
    this.messages.push({ text: lines, until: performance.now() + seconds * 1000, warn });
    if (this.messages.length > 4) this.messages.shift();
  }

  clearMessages(): void {
    this.messages = [];
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
  }

  draw(f: HudFrame, project: Projector): void {
    if (this.canvas.hidden) return;
    this.resize();
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    if (!this.visible) return;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const W = this.w;
    const H = this.h;
    const cx = W / 2;
    // The aircraft sits slightly below center; the tapes flank it.
    const cy = H * 0.55;
    const s = Math.min(1.25, Math.max(0.75, H / 900));
    c.font = `${Math.round(14 * s)}px ui-monospace, 'JetBrains Mono', Consolas, monospace`;

    // Tapes flank the aircraft at a share of the width; the numbers stack under them.
    const tx = Math.min(0.3 * W, 400 * s);
    const span = 120 * s;
    this.worldSymbols(f, project, s);
    this.speedTape(f, cx - tx, cy, s);
    this.altitudeTape(f, cx + tx, cy, s);
    this.headingTape(f, cx, 70 * s, s);
    this.numbers(f, cx - tx - 28 * s, cy + span + 44 * s, s);
    this.attitude(f, cx - tx + 6 * s, cy + span + 118 * s, s);
    this.status(f, cx + tx, cy + span + 44 * s, s);
    this.landingAid(f, cx + tx - 150 * s, cy - span - 120 * s, s);
    this.messagesAndWarnings(f, cx, 130 * s, s);
    // Below the app's frame-time readout.
    if (f.debug) this.debugPanel(f, 16, 64, s);
    if (f.aim) {
      const x = ((f.aim.x + 1) / 2) * W;
      const y = ((1 - f.aim.y) / 2) * H;
      this.stroke(() => {
        c.beginPath();
        c.arc(x, y, 10 * s, 0, 2 * Math.PI);
        c.moveTo(x - 4 * s, y);
        c.lineTo(x + 4 * s, y);
      });
    }
  }

  // ---- Drawing helpers ----

  /** Strokes a path twice: the halo, then the symbol. */
  private stroke(path: () => void, color = HUD_COLOR, width = 1.6): void {
    const c = this.ctx;
    c.strokeStyle = HALO;
    c.lineWidth = width + 2.4;
    path();
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = width;
    path();
    c.stroke();
  }

  private text(
    t: string,
    x: number,
    y: number,
    align: CanvasTextAlign = 'left',
    color = HUD_COLOR,
  ): void {
    const c = this.ctx;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.lineWidth = 3;
    c.strokeStyle = HALO;
    c.strokeText(t, x, y);
    c.fillStyle = color;
    c.fillText(t, x, y);
  }

  // ---- World-anchored ----

  private worldSymbols(f: HudFrame, project: Projector, s: number): void {
    const c = this.ctx;
    // Boresight cross.
    const b = project(...f.boresight, false);
    if (b) {
      this.stroke(() => {
        c.beginPath();
        c.moveTo(b.x - 9 * s, b.y);
        c.lineTo(b.x - 3 * s, b.y);
        c.moveTo(b.x + 3 * s, b.y);
        c.lineTo(b.x + 9 * s, b.y);
        c.moveTo(b.x, b.y - 9 * s);
        c.lineTo(b.x, b.y - 3 * s);
      });
    }
    // Flight path marker: a circle with wings and a fin.
    if (Math.hypot(...f.velocity) > 0.5) {
      const p = project(...f.velocity, false);
      if (p) {
        const r = 7 * s;
        this.stroke(
          () => {
            c.beginPath();
            c.arc(p.x, p.y, r, 0, 2 * Math.PI);
            c.moveTo(p.x - r, p.y);
            c.lineTo(p.x - 2.6 * r, p.y);
            c.moveTo(p.x + r, p.y);
            c.lineTo(p.x + 2.6 * r, p.y);
            c.moveTo(p.x, p.y - r);
            c.lineTo(p.x, p.y - 1.9 * r);
          },
          HUD_COLOR,
          2,
        );
      }
    }
    // Destination runway: outline and aim point.
    if (f.aid) {
      const pts = f.aid.corners.map((q) => project(q[0], q[1], q[2], true));
      if (pts.every((p) => p !== null)) {
        this.stroke(() => {
          c.beginPath();
          pts.forEach((p, i) => (i === 0 ? c.moveTo(p!.x, p!.y) : c.lineTo(p!.x, p!.y)));
          c.closePath();
        });
      }
      const a = project(...f.aid.aim, true);
      if (a) {
        const d = 5 * s;
        this.stroke(() => {
          c.beginPath();
          c.moveTo(a.x, a.y - d);
          c.lineTo(a.x + d, a.y);
          c.lineTo(a.x, a.y + d);
          c.lineTo(a.x - d, a.y);
          c.closePath();
        });
        this.text(f.aid.designator, a.x + 9 * s, a.y - 9 * s);
      }
    }
  }

  // ---- Tapes ----

  private speedTape(f: HudFrame, x: number, y: number, s: number): void {
    const c = this.ctx;
    const kias = f.cas / KNOT;
    const span = 120 * s;
    const pxPerKt = span / 60;
    this.stroke(() => {
      c.beginPath();
      c.moveTo(x + 30 * s, y - span);
      c.lineTo(x + 30 * s, y + span);
      for (let v = Math.ceil((kias - 60) / 10) * 10; v <= kias + 60; v += 10) {
        if (v < 0) continue;
        const ty = y - (v - kias) * pxPerKt;
        c.moveTo(x + 30 * s, ty);
        c.lineTo(x + (v % 50 === 0 ? 18 : 23) * s, ty);
      }
    });
    for (let v = Math.ceil((kias - 60) / 50) * 50; v <= kias + 60; v += 50) {
      if (v < 0) continue;
      const ty = y - (v - kias) * pxPerKt;
      if (Math.abs(ty - y) > 14 * s) this.text(String(v), x + 14 * s, ty, 'right');
    }
    this.box(x - 30 * s, y, 58 * s, `${Math.round(kias)}`, 'right');
    this.text(`M ${f.mach.toFixed(2)}`, x + 28 * s, y + span + 18 * s, 'right');
  }

  private altitudeTape(f: HudFrame, x: number, y: number, s: number): void {
    const c = this.ctx;
    const ft = f.altitude / FOOT;
    const span = 120 * s;
    const window = 1000;
    const pxPerFt = span / (window / 2);
    this.stroke(() => {
      c.beginPath();
      c.moveTo(x - 30 * s, y - span);
      c.lineTo(x - 30 * s, y + span);
      for (let v = Math.ceil((ft - window / 2) / 100) * 100; v <= ft + window / 2; v += 100) {
        const ty = y - (v - ft) * pxPerFt;
        c.moveTo(x - 30 * s, ty);
        c.lineTo(x - (v % 500 === 0 ? 18 : 23) * s, ty);
      }
    });
    for (let v = Math.ceil((ft - window / 2) / 500) * 500; v <= ft + window / 2; v += 500) {
      const ty = y - (v - ft) * pxPerFt;
      if (Math.abs(ty - y) > 14 * s) this.text(v.toLocaleString('en-US'), x - 14 * s, ty, 'left');
    }
    this.box(x + 36 * s, y, 74 * s, Math.round(ft).toLocaleString('en-US'), 'left');
    const vs = (f.verticalSpeed / FOOT) * 60;
    this.text(
      `${vs >= 0 ? '+' : '−'}${Math.abs(Math.round(vs / 10) * 10).toLocaleString('en-US')} fpm`,
      x - 28 * s,
      y - span - 18 * s,
      'left',
    );
    const ra = f.radarAltitude / FOOT;
    if (ra < 1500)
      this.text(
        `R ${Math.max(0, Math.round(ra)).toLocaleString('en-US')}`,
        x - 28 * s,
        y + span + 18 * s,
        'left',
      );
  }

  /** A boxed current value beside a tape. */
  private box(x: number, y: number, w: number, value: string, align: 'left' | 'right'): void {
    const c = this.ctx;
    const h = 22;
    const x0 = align === 'right' ? x - w / 2 : x - w / 2;
    this.stroke(() => {
      c.beginPath();
      c.rect(x0, y - h / 2, w, h);
    });
    this.text(value, x, y, 'center');
  }

  private headingTape(f: HudFrame, x: number, y: number, s: number): void {
    const c = this.ctx;
    const hdg = (((f.heading / DEG) % 360) + 360) % 360;
    const half = 160 * s;
    const pxPerDeg = half / 30;
    this.stroke(() => {
      c.beginPath();
      for (let d = Math.ceil((hdg - 30) / 5) * 5; d <= hdg + 30; d += 5) {
        const tx = x + (d - hdg) * pxPerDeg;
        c.moveTo(tx, y);
        c.lineTo(tx, y + (d % 10 === 0 ? 10 : 6) * s);
      }
      c.moveTo(x, y + 14 * s);
      c.lineTo(x - 5 * s, y + 22 * s);
      c.moveTo(x, y + 14 * s);
      c.lineTo(x + 5 * s, y + 22 * s);
    });
    for (let d = Math.ceil((hdg - 30) / 10) * 10; d <= hdg + 30; d += 10) {
      const tx = x + (d - hdg) * pxPerDeg;
      const v = ((d % 360) + 360) % 360;
      if (Math.abs(tx - x) > 22 * s)
        this.text(String(v).padStart(3, '0'), tx, y - 10 * s, 'center');
    }
    this.text(String(Math.round(hdg) % 360).padStart(3, '0'), x, y - 10 * s, 'center');
  }

  // ---- Attitude, numbers, status ----

  private attitude(f: HudFrame, x: number, y: number, s: number): void {
    const c = this.ctx;
    const r = 34 * s;
    // Horizon: rotated by bank, displaced by pitch (1.2 px per degree at s = 1).
    const k = (1.0 * s * f.pitch) / DEG;
    c.save();
    c.beginPath();
    c.arc(x, y, r, 0, 2 * Math.PI);
    c.clip();
    c.translate(x, y);
    c.rotate(-f.bank);
    this.stroke(() => {
      c.beginPath();
      c.moveTo(-2 * r, k);
      c.lineTo(2 * r, k);
      for (const p of [-20, -10, 10, 20]) {
        const py = k - p * 1.0 * s;
        c.moveTo(-r * 0.3, py);
        c.lineTo(r * 0.3, py);
      }
    });
    c.restore();
    this.stroke(() => {
      c.beginPath();
      c.arc(x, y, r, 0, 2 * Math.PI);
      c.moveTo(x - r * 0.55, y);
      c.lineTo(x - r * 0.18, y);
      c.lineTo(x, y + r * 0.12);
      c.lineTo(x + r * 0.18, y);
      c.lineTo(x + r * 0.55, y);
    });
    this.text(`${Math.round(f.pitch / DEG)}°`, x + r + 6 * s, y - 8 * s);
    this.text(
      `${Math.round(Math.abs(f.bank) / DEG)}°${f.bank > 0.5 * DEG ? 'R' : f.bank < -0.5 * DEG ? 'L' : ''}`,
      x + r + 6 * s,
      y + 10 * s,
    );
  }

  /** Load factor, angle of attack and the approach indexer (13° on speed, gear down). */
  private numbers(f: HudFrame, x: number, y: number, s: number): void {
    const c = this.ctx;
    this.text(`G ${f.load.toFixed(1)}`, x, y);
    this.text(`α ${(f.alpha / DEG).toFixed(1)}`, x, y + 18 * s);
    if (f.gearDown && !f.onGround) {
      const a = f.alpha / DEG;
      const ix = x + 84 * s;
      const iy = y + 18 * s;
      const d = 6 * s;
      const off = a > 14.5 || a < 11.5;
      this.stroke(
        () => {
          c.beginPath();
          if (a > 14.5) {
            // Slow: chevron pointing down (lower the nose).
            c.moveTo(ix - d, iy - d / 2);
            c.lineTo(ix, iy + d / 2);
            c.lineTo(ix + d, iy - d / 2);
          } else if (a < 11.5) {
            // Fast: chevron pointing up.
            c.moveTo(ix - d, iy + d / 2);
            c.lineTo(ix, iy - d / 2);
            c.lineTo(ix + d, iy + d / 2);
          } else {
            c.arc(ix, iy, d * 0.8, 0, 2 * Math.PI);
          }
        },
        off ? WARN_COLOR : HUD_COLOR,
      );
    }
  }

  private status(f: HudFrame, x: number, y: number, s: number): void {
    const lines: [string, string?][] = [];
    const lever = f.throttle;
    x += 28 * s;
    const thr =
      f.afterburner > 0.02 || lever > 0.81
        ? `AB ${Math.max(1, Math.min(5, Math.ceil(((lever - 0.82) / 0.18) * 5) || 1))}`
        : lever >= 0.799
          ? 'MIL'
          : lever <= 0.001
            ? 'IDLE'
            : `${Math.round(60 + 40 * (lever / 0.8))}%`;
    lines.push([`THR ${thr}`]);
    const lb = f.fuel / 0.453_592;
    lines.push([
      `FUEL ${Math.round(lb / 10) * 10 > 0 ? (Math.round(lb / 10) * 10).toLocaleString('en-US') : 0} LB${f.unlimitedFuel ? ' ∞' : ''}`,
      f.fuel < 500 && !f.unlimitedFuel ? WARN_COLOR : undefined,
    ]);
    lines.push([
      f.gear >= 0.999 ? 'GEAR DOWN' : f.gear <= 0.001 ? 'GEAR UP' : 'GEAR ▒ TRANSIT',
      f.gear > 0.001 && f.gear < 0.999 ? WARN_COLOR : undefined,
    ]);
    if (f.speedbrake > 0.02) lines.push(['SPD BRK']);
    if (f.parkingBrake) lines.push(['PARK BRK', WARN_COLOR]);
    else if (f.brakes) lines.push(['BRAKES']);
    lines.push([f.mode.toUpperCase()]);
    lines.forEach(([t, color], i) => this.text(t, x - 28 * s, y + i * 18 * s, 'left', color));
  }

  private landingAid(f: HudFrame, x: number, y: number, s: number): void {
    const a = f.aid;
    if (!a) return;
    const c = this.ctx;
    const nm = a.distance / NAUTICAL_MILE;
    const brg = String(Math.round((((a.bearing / DEG) % 360) + 360) % 360)).padStart(3, '0');
    this.text(`${a.name}`, x, y - 22 * s, 'left');
    this.text(
      `RWY ${a.designator}  ${nm < 10 ? nm.toFixed(1) : Math.round(nm)} NM  ${brg}°`,
      x,
      y - 4 * s,
      'left',
    );
    // Deviation box: localizer (vertical bar) and glideslope (horizontal bar).
    const bw = 56 * s;
    const bx = x + bw / 2;
    const by = y + 14 * s + bw / 2;
    this.stroke(
      () => {
        c.beginPath();
        c.rect(bx - bw / 2, by - bw / 2, bw, bw);
        for (const k of [-1, -0.5, 0.5, 1]) {
          c.moveTo(bx + (k * bw) / 2, by + bw / 2);
          c.lineTo(bx + (k * bw) / 2, by + bw / 2 - 4 * s);
          c.moveTo(bx - bw / 2, by + (k * bw) / 2);
          c.lineTo(bx - bw / 2 + 4 * s, by + (k * bw) / 2);
        }
      },
      HUD_COLOR,
      1.2,
    );
    const lx = bx + (Math.max(-1, Math.min(1, a.localizer)) * bw) / 2;
    const gy = by - (Math.max(-1, Math.min(1, a.glideslope)) * bw) / 2;
    this.stroke(
      () => {
        c.beginPath();
        c.moveTo(lx, by - bw / 2);
        c.lineTo(lx, by + bw / 2);
        c.moveTo(bx - bw / 2, gy);
        c.lineTo(bx + bw / 2, gy);
      },
      HUD_COLOR,
      2.2,
    );
    this.text('LOC', bx + bw / 2 + 6 * s, by - 8 * s, 'left');
    this.text('GS', bx + bw / 2 + 6 * s, by + 10 * s, 'left');
  }

  private messagesAndWarnings(f: HudFrame, x: number, y: number, s: number): void {
    const now = performance.now();
    this.messages = this.messages.filter((m) => m.until > now);
    let row = 0;
    const blink = Math.floor(now / 350) % 2 === 0;
    for (const w of f.warnings) {
      if (w === 'pull-up' && !blink) {
        row++;
        continue;
      }
      this.text(WARNING_TEXT[w], x, y + row * 20 * s, 'center', WARN_COLOR);
      row++;
    }
    for (const m of this.messages) {
      for (const line of m.text) {
        this.text(line, x, y + row * 20 * s, 'center', m.warn ? WARN_COLOR : HUD_COLOR);
        row++;
      }
    }
  }

  private debugPanel(f: HudFrame, x: number, y: number, s: number): void {
    const d = f.debug!;
    const c = this.ctx;
    const kN = (v: number) => (v / 1000).toFixed(1).padStart(7);
    const lines = [
      `α ${(f.alpha / DEG).toFixed(2)}°  β ${(f.beta / DEG).toFixed(2)}°`,
      `CL ${d.cl.toFixed(3)}  CD ${d.cd.toFixed(4)}`,
      `thrust ${(d.thrust / 1000).toFixed(1)} kN  q ${(d.qbar / 1000).toFixed(2)} kPa`,
      `n ${f.load.toFixed(2)} g  pitch law ${d.blend < 0.5 ? 'rate' : 'load'} (${d.blend.toFixed(2)})`,
      `body forces (kN)    x       y       z`,
      `  aero    ${kN(d.aero[0])} ${kN(d.aero[1])} ${kN(d.aero[2])}`,
      `  gear    ${kN(d.gear[0])} ${kN(d.gear[1])} ${kN(d.gear[2])}`,
      `  gravity ${kN(d.gravity[0])} ${kN(d.gravity[1])} ${kN(d.gravity[2])}`,
      `frame ${d.frameMs.toFixed(1)} ms  physics ${d.physicsMs.toFixed(2)} ms (${d.steps} steps)`,
    ];
    const lh = 16 * s;
    c.fillStyle = 'rgba(0, 0, 0, 0.6)';
    c.fillRect(x - 8, y - 8, 420 * s, lines.length * lh + 16);
    c.font = `${Math.round(12.5 * s)}px ui-monospace, Consolas, monospace`;
    lines.forEach((l, i) => {
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillStyle = '#F2F2F2';
      c.fillText(l, x, y + i * lh);
    });
  }

  dispose(): void {
    this.canvas.remove();
  }
}
