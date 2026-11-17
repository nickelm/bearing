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
 * - **Helicopter layout** (when the frame carries `hover`; decision 149): the
 *   velocity vector on the ground plane from the ground point with the
 *   acceleration cue at its tip, the landing zone's marker (a caret at the edge
 *   when off screen), a digital radar altitude with the vertical speed under it (amber in a hard
 *   descent near the ground; decision 160) and a vertical-speed bar, torque
 *   and rotor RPM, ground speed, mode tags and hazard cues. It leaves out what
 *   only a jet has: Mach, G, α and the indexer, throttle stages, speedbrake, and
 *   the landing aid's needles (the runway outline stays); the flight path marker
 *   shows only above 12 m/s, where the velocity's direction means something.
 *
 * The F-21 is an Alliance aircraft, so the HUD reads knots and feet. One color,
 * green, with a thin dark halo, so it stays legible on bright sky and snow
 * (Part I, HUD and Displays; tuned in P2).
 */
import './flight.css';
import { DEG, FOOT, KNOT, NAUTICAL_MILE } from '../../core/units';
import type { Vec3d } from '../../core/vec3d';
import type { FlightWarning } from '../../sim/flight/outcomes';
import { drawControlCursor } from './controlCursor';
import type { ControlCursor } from './controlCursor';

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

/**
 * The helicopter's hover symbology (decision 149, Proposal 0004, HUD and Camera).
 * When a frame carries it, the HUD draws the helicopter layout.
 */
export interface HoverHud {
  /** Ground velocity in the heading frame (m/s): + forward, + right; and its acceleration (m/s², same frame). */
  velocity: { forward: number; right: number };
  accel: { forward: number; right: number };
  /**
   * World-anchored: the point on the ground under the aircraft, and the tips of
   * the velocity vector and acceleration cue on the ground plane, each relative
   * to the camera eye (m). `hoverSymbols` in freeflight/hudFrame.ts builds them.
   */
  groundPoint: Vec3d;
  velocityTip: Vec3d;
  accelTip: Vec3d;
  /** Height above the ground (m). */
  radarAltitude: number;
  /** Vertical speed (m/s, + up). */
  verticalSpeed: number;
  /** Torque and rotor speed as fractions of their maximum and governed values (1 = 100 %). */
  torque: number;
  rotorRpm: number;
  /** Landing zone: distance (m), bearing relative to the nose (rad, + right), and its point relative to the eye; or null. */
  lz: { distance: number; bearing: number; point: Vec3d } | null;
  /** Active assists and modes shown as short tags, e.g. 'HOVER HOLD', 'ALT HOLD', 'ASSISTED'. */
  modes: string[];
  /** Hazard cues ('VRS', 'MAST BUMP', 'RBS', 'ROLLOVER', 'LOW RPM', 'TORQUE'): amber, the severe ones flashing. */
  hazards: string[];
}

/** Hazards that flash: those that need action within a second or two. */
export const SEVERE_HAZARDS: ReadonlySet<string> = new Set([
  'VRS',
  'MAST BUMP',
  'ROLLOVER',
  'LOW RPM',
]);

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
  /** The mouse's control cursor, drawn in its own color (controlCursor.ts, decision 198). */
  control?: ControlCursor | null;
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
  /** Helicopters: the hover symbology; absent or null for fixed-wing aircraft. */
  hover?: HoverHud | null;
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

/** Time to the ground (s) at the current sink below which `sinkWarning` warns. */
export const SINK_WARNING_TIME = 1.6;

/**
 * Whether a helicopter's descent would meet the ground hard: sinking faster
 * than 2 m/s (about 400 fpm) with less than SINK_WARNING_TIME to the ground at
 * that rate. The landing aid's eased descent, as both types fly it, keeps at
 * least 2.2 s in hand (tests/rotorcraft.test.ts), so it stays white; without
 * the aid, S held to the ground meets it at about 7.7 m/s, with about 1.6 s of
 * amber first. The types' crash sinks are 4–5 m/s.
 * `verticalSpeed` (m/s, up positive) and `radarAltitude` (m).
 */
export function sinkWarning(verticalSpeed: number, radarAltitude: number): boolean {
  const sink = -verticalSpeed;
  return sink > 2 && radarAltitude < SINK_WARNING_TIME * sink;
}

/** A vertical speed (fpm) as the HUD writes it: signed, to 10 fpm, "0" when level. */
export function verticalSpeedText(fpm: number): string {
  const v = Math.round(fpm / 10) * 10;
  if (v === 0) return '0';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US')}`;
}

/** A landing zone's distance: feet to the nearest 10 within 0.3 NM, nautical miles beyond. */
export function hoverDistance(d: number): string {
  const nm = d / NAUTICAL_MILE;
  if (nm < 0.3) return `${Math.round(d / FOOT / 10) * 10} FT`;
  return `${nm < 10 ? nm.toFixed(1) : Math.round(nm)} NM`;
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
    const hv = f.hover ?? null;
    this.worldSymbols(f, project, s);
    if (hv) this.hoverWorld(hv, project, s);
    this.speedTape(f, cx - tx, cy, s);
    this.altitudeTape(f, cx + tx, cy, s);
    this.headingTape(f, cx, 70 * s, s);
    if (hv) {
      this.hoverAltitude(hv, cx + tx, cy, s);
      this.rotor(hv, cx - tx - 28 * s, cy + span + 44 * s, s);
    } else {
      this.numbers(f, cx - tx - 28 * s, cy + span + 44 * s, s);
    }
    this.attitude(f, cx - tx + 6 * s, cy + span + 118 * s, s);
    this.status(f, cx + tx, cy + span + 44 * s, s);
    if (hv) this.landingZone(f, hv, cx + tx - 150 * s, cy - span - 120 * s, s);
    else this.landingAid(f, cx + tx - 150 * s, cy - span - 120 * s, s);
    this.messagesAndWarnings(f, cx, 130 * s, s);
    // Below the app's frame-time readout.
    if (f.debug) this.debugPanel(f, 16, 64, s);
    if (f.control) drawControlCursor(c, f.control, project, W, H, s);
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
    // A helicopter's velocity points anywhere in the hover: its marker waits for 12 m/s.
    if (Math.hypot(...f.velocity) > (f.hover ? 12 : 0.5)) {
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
    if (f.hover) {
      const gs = Math.hypot(f.hover.velocity.forward, f.hover.velocity.right) / KNOT;
      this.text(`GS ${Math.round(gs)}`, x + 28 * s, y + span + 18 * s, 'right');
    } else {
      this.text(`M ${f.mach.toFixed(2)}`, x + 28 * s, y + span + 18 * s, 'right');
    }
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
    // The helicopter layout writes it beside the radar altitude (hoverAltitude).
    const vs = (f.verticalSpeed / FOOT) * 60;
    if (!f.hover)
      this.text(
        `${vs >= 0 ? '+' : '−'}${Math.abs(Math.round(vs / 10) * 10).toLocaleString('en-US')} fpm`,
        x - 28 * s,
        y - span - 18 * s,
        'left',
      );
    const ra = f.radarAltitude / FOOT;
    // The helicopter layout draws its own radar altitude (hoverAltitude).
    if (ra < 1500 && !f.hover)
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
      if (Math.abs(tx - x) > 30 * s)
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
    if (f.hover) return this.hoverStatus(f, f.hover, x, y, s);
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
    lines.push(this.fuelLine(f));
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
    if (f.hover && f.hover.hazards.length > 0) {
      this.hazards(f.hover.hazards, x, y, s, blink);
      row += 1.7;
    }
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

  // ---- Helicopter layout ----

  /** Draws `fn` in a font of `px` CSS pixels, then restores the HUD's font. */
  private withFont(px: number, fn: () => void): void {
    const c = this.ctx;
    const saved = c.font;
    c.font = `${Math.round(px)}px ui-monospace, 'JetBrains Mono', Consolas, monospace`;
    fn();
    c.font = saved;
  }

  /**
   * World-anchored hover symbols: a cross at the ground point, the velocity
   * vector along the ground to its tip, the acceleration cue (a circle; centered
   * on the cross in a steady hover), and the landing zone's marker, or a caret
   * at the screen's edge pointing to it.
   */
  private hoverWorld(hv: HoverHud, project: Projector, s: number): void {
    const c = this.ctx;
    const at = (p: Readonly<Vec3d>) => project(p.x, p.y, p.z, true);
    const g = at(hv.groundPoint);
    if (g) {
      const v = at(hv.velocityTip);
      const a = at(hv.accelTip);
      const d = 8 * s;
      this.stroke(() => {
        c.beginPath();
        c.moveTo(g.x - d, g.y);
        c.lineTo(g.x + d, g.y);
        c.moveTo(g.x, g.y - d);
        c.lineTo(g.x, g.y + d);
      });
      if (v && Math.hypot(v.x - g.x, v.y - g.y) > 2) {
        this.stroke(
          () => {
            c.beginPath();
            c.moveTo(g.x, g.y);
            c.lineTo(v.x, v.y);
          },
          HUD_COLOR,
          2.6,
        );
      }
      if (a) {
        this.stroke(() => {
          c.beginPath();
          c.arc(a.x, a.y, 5.5 * s, 0, 2 * Math.PI);
        });
      }
    }
    const lz = hv.lz;
    if (!lz) return;
    const W = this.w;
    const H = this.h;
    // The caret stays inside these margins, clear of the heading tape.
    const m = 36 * s;
    const top = 112 * s;
    const p = at(lz.point);
    if (p && p.x >= m && p.x <= W - m && p.y >= top && p.y <= H - m) {
      const r = 14 * s;
      const k = 5.5 * s;
      this.stroke(() => {
        c.beginPath();
        c.moveTo(p.x, p.y - r);
        c.lineTo(p.x + r, p.y);
        c.lineTo(p.x, p.y + r);
        c.lineTo(p.x - r, p.y);
        c.closePath();
        c.moveTo(p.x - k, p.y - k);
        c.lineTo(p.x - k, p.y + k);
        c.moveTo(p.x + k, p.y - k);
        c.lineTo(p.x + k, p.y + k);
        c.moveTo(p.x - k, p.y);
        c.lineTo(p.x + k, p.y);
      });
      this.text(hoverDistance(lz.distance), p.x + r + 6 * s, p.y, 'left');
      return;
    }
    // Off screen: toward its projection, or, behind the camera, by its bearing (lower half).
    const ox = W / 2;
    const oy = H / 2;
    let dx = p ? p.x - ox : Math.sin(lz.bearing);
    let dy = p ? p.y - oy : Math.abs(Math.cos(lz.bearing));
    const n = Math.hypot(dx, dy);
    if (n < 1e-6) {
      dx = 0;
      dy = 1;
    } else {
      dx /= n;
      dy /= n;
    }
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (W - m - ox) / dx);
    if (dx < -1e-6) t = Math.min(t, (m - ox) / dx);
    if (dy > 1e-6) t = Math.min(t, (H - m - oy) / dy);
    if (dy < -1e-6) t = Math.min(t, (top - oy) / dy);
    const ex = ox + dx * t;
    const ey = oy + dy * t;
    const l = 12 * s;
    const w = 8 * s;
    this.stroke(
      () => {
        c.beginPath();
        c.moveTo(ex - dx * l - dy * w, ey - dy * l + dx * w);
        c.lineTo(ex, ey);
        c.lineTo(ex - dx * l + dy * w, ey - dy * l - dx * w);
      },
      HUD_COLOR,
      2.2,
    );
    // The label sits inward of the caret: beyond its tail on the side edges, and
    // a line further in on the top and bottom.
    const lx = ex - dx * 20 * s;
    const ly = ey - dy * 20 * s - (Math.abs(dy) > 0.5 ? Math.sign(dy) * 12 * s : 0);
    const align: CanvasTextAlign = dx > 0.5 ? 'right' : dx < -0.5 ? 'left' : 'center';
    this.text(`LZ ${hoverDistance(lz.distance)}`, lx, ly, align);
  }

  /**
   * Radar altitude (feet, boxed and larger) with the vertical speed (fpm) under it,
   * and the vertical-speed bar (±1,000 fpm) inside the altitude tape; the speed and
   * the bar turn amber in a descent that would meet the ground hard (sinkWarning).
   */
  private hoverAltitude(hv: HoverHud, x: number, y: number, s: number): void {
    const c = this.ctx;
    const half = 90 * s;
    const sx = x - 50 * s;
    this.stroke(
      () => {
        c.beginPath();
        c.moveTo(sx, y - half);
        c.lineTo(sx, y + half);
        for (const k of [-1, -0.5, 0, 0.5, 1]) {
          c.moveTo(sx, y - k * half);
          c.lineTo(sx - (k === 0 ? 9 : 5) * s, y - k * half);
        }
      },
      HUD_COLOR,
      1.2,
    );
    const fpm = (hv.verticalSpeed / FOOT) * 60;
    const warn = sinkWarning(hv.verticalSpeed, hv.radarAltitude);
    const color = warn ? WARN_COLOR : HUD_COLOR;
    const k = Math.max(-1, Math.min(1, fpm / 1000));
    if (Math.abs(k) > 0.01) {
      this.stroke(
        () => {
          c.beginPath();
          c.moveTo(sx + 5 * s, y);
          c.lineTo(sx + 5 * s, y - k * half);
        },
        color,
        3.6,
      );
    }
    const bw = 58 * s;
    const bh = 28 * s;
    const bx = sx - 14 * s - bw / 2;
    // The vertical speed under the box (in its place above 1,500 ft).
    const ra = hv.radarAltitude / FOOT;
    const vy = ra < 1500 ? y + bh / 2 + 15 * s : y;
    this.withFont(17 * s, () => this.text(verticalSpeedText(fpm), bx, vy, 'center', color));
    this.text('VS', bx - bw / 2 - 6 * s, vy, 'right', color);
    if (ra >= 1500) return;
    const v = ra < 50 ? Math.round(ra) : Math.round(ra / 10) * 10;
    this.stroke(() => {
      c.beginPath();
      c.rect(bx - bw / 2, y - bh / 2, bw, bh);
    });
    this.withFont(20 * s, () => this.text(String(Math.max(0, v)), bx, y + 1, 'center'));
    this.text('R', bx - bw / 2 - 6 * s, y, 'right');
  }

  /** Torque and rotor RPM; RPM larger, both amber outside their limits (torque over 100 %, RPM outside 95–105 %). */
  private rotor(hv: HoverHud, x: number, y: number, s: number): void {
    this.text(
      `TRQ ${Math.round(hv.torque * 100)}%`,
      x,
      y,
      'left',
      hv.torque > 1 ? WARN_COLOR : HUD_COLOR,
    );
    const off = hv.rotorRpm < 0.95 || hv.rotorRpm > 1.05;
    this.withFont(20 * s, () =>
      this.text(
        `NR ${Math.round(hv.rotorRpm * 100)}%`,
        x,
        y + 24 * s,
        'left',
        off ? WARN_COLOR : HUD_COLOR,
      ),
    );
  }

  /** Fuel, gear when it is not down and locked (skids never show), brakes, the mode tags and the control mode. */
  private hoverStatus(f: HudFrame, hv: HoverHud, x: number, y: number, s: number): void {
    const lines: [string, string?][] = [this.fuelLine(f)];
    if (f.gear < 0.999)
      lines.push([
        f.gear <= 0.001 ? 'GEAR UP' : 'GEAR ▒ TRANSIT',
        f.gear > 0.001 ? WARN_COLOR : undefined,
      ]);
    if (f.parkingBrake) lines.push(['PARK BRK', WARN_COLOR]);
    else if (f.brakes) lines.push(['BRAKES']);
    for (const m of hv.modes) lines.push([m.toUpperCase()]);
    lines.push([f.mode.toUpperCase()]);
    lines.forEach(([t, color], i) => this.text(t, x, y + i * 18 * s, 'left', color));
  }

  private fuelLine(f: HudFrame): [string, string?] {
    const lb = Math.round(f.fuel / 0.453_592 / 10) * 10;
    return [
      `FUEL ${lb > 0 ? lb.toLocaleString('en-US') : 0} LB${f.unlimitedFuel ? ' ∞' : ''}`,
      f.fuel < 500 && !f.unlimitedFuel ? WARN_COLOR : undefined,
    ];
  }

  /** The landing zone's distance and bearing off the nose, under the destination runway's line. */
  private landingZone(f: HudFrame, hv: HoverHud, x: number, y: number, s: number): void {
    const a = f.aid;
    if (a) {
      const nm = a.distance / NAUTICAL_MILE;
      const brg = String(Math.round((((a.bearing / DEG) % 360) + 360) % 360)).padStart(3, '0');
      this.text(
        `RWY ${a.designator}  ${nm < 10 ? nm.toFixed(1) : Math.round(nm)} NM  ${brg}°`,
        x,
        y - 22 * s,
        'left',
      );
    }
    const lz = hv.lz;
    if (!lz) return;
    const deg = Math.round(Math.abs(lz.bearing) / DEG);
    const side = deg === 0 ? '' : lz.bearing > 0 ? 'R' : 'L';
    this.text(
      `LZ  ${hoverDistance(lz.distance)}  ${String(deg).padStart(3, '0')}°${side}`,
      x,
      y - 4 * s,
      'left',
    );
  }

  /** Hazard cues in a centered row of amber boxes; the severe ones flash between filled and outlined. */
  private hazards(list: string[], x: number, y: number, s: number, blink: boolean): void {
    const c = this.ctx;
    const pad = 8 * s;
    const gap = 12 * s;
    const h = 26 * s;
    this.withFont(17 * s, () => {
      const widths = list.map((t) => c.measureText(t).width + 2 * pad);
      let left = x - (widths.reduce((a, b) => a + b, 0) + gap * (list.length - 1)) / 2;
      list.forEach((t, i) => {
        const w = widths[i]!;
        const filled = SEVERE_HAZARDS.has(t) && blink;
        if (filled) {
          c.strokeStyle = HALO;
          c.lineWidth = 2.4;
          c.strokeRect(left, y - h / 2, w, h);
          c.fillStyle = WARN_COLOR;
          c.fillRect(left, y - h / 2, w, h);
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillStyle = '#1A1B1D';
          c.fillText(t, left + w / 2, y);
        } else {
          this.stroke(
            () => {
              c.beginPath();
              c.rect(left, y - h / 2, w, h);
            },
            WARN_COLOR,
            1.6,
          );
          this.text(t, left + w / 2, y, 'center', WARN_COLOR);
        }
        left += w + gap;
      });
    });
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
