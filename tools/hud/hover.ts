/**
 * The helicopter HUD's hover symbology (decision 149) without a render:
 * `composite.html?hover=<case>` places a helicopter over flat ground, frames it
 * with the real chase camera on `helicopterRig`, draws a stand-in scene (sky,
 * a 10 m ground grid, a block helicopter with its rotor disc) through the same
 * projector, and the real Canvas HUD over it with a frame from `hoverSymbols`.
 * Cases: hover (a steady hover with a small drift, the LZ in view), hazard
 * (settling with power, low rotor RPM, over-torque, the LZ behind), transition
 * (35 kt and accelerating, the LZ off the top), sink (a landing come in at
 * 3.2 m/s from 6 m: the vertical speed in amber), snow (the hover over white
 * ground under a pale sky, for the halo). tools/freeflight.screens.mjs shoots
 * them as `SHOTS=hover-hover,hover-hazard,…`.
 */
import { DEG, KNOT } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { hoverSymbols } from '../../src/freeflight/hudFrame';
import { ChaseCamera, helicopterRig } from '../../src/render/sim/camera/chaseCamera';
import { Hud, matrixProjector } from '../../src/ui/flight/hud';
import type { HudFrame, HudLandingAid, Projector } from '../../src/ui/flight/hud';

const R = 1_000_000;
const ROTOR = 7.3;
const GROUND = 120;

interface Case {
  /** Height of the reference point above the ground (m), heading (rad), pitch and bank (rad). */
  height: number;
  heading: number;
  pitch: number;
  bank: number;
  /** Velocity and acceleration in the heading frame (m/s, m/s²): forward, right, up. */
  vel: [number, number, number];
  acc: [number, number, number];
  torque: number;
  rpm: number;
  /** Landing zone in the heading frame (m): forward, right; or null. */
  lz: [number, number] | null;
  modes: string[];
  hazards: string[];
  aid: boolean;
  snow: boolean;
}

const CASES: Record<string, Case> = {
  hover: {
    height: 5.5,
    heading: 40 * DEG,
    pitch: 4 * DEG,
    bank: -2 * DEG,
    vel: [0.9, 0.6, 0.1],
    acc: [-0.5, -0.2, 0],
    torque: 0.68,
    rpm: 1.0,
    lz: [45, 14],
    modes: ['HOVER HOLD', 'ASSISTED'],
    hazards: [],
    aid: false,
    snow: false,
  },
  hazard: {
    height: 18,
    heading: 310 * DEG,
    pitch: 9 * DEG,
    bank: 3 * DEG,
    vel: [1.4, -1.1, -4.2],
    acc: [-0.4, 0.3, -0.8],
    torque: 1.06,
    rpm: 0.91,
    lz: [-220, -160],
    modes: ['ASSISTED'],
    hazards: ['VRS', 'LOW RPM', 'TORQUE'],
    aid: false,
    snow: false,
  },
  sink: {
    // A landing come in too fast: 3.2 m/s down at 6 m (decision 160's amber vertical speed).
    height: 6,
    heading: 200 * DEG,
    pitch: 5 * DEG,
    bank: 1 * DEG,
    vel: [2.0, 0.3, -3.2],
    acc: [-0.6, 0, 0.4],
    torque: 0.55,
    rpm: 1.0,
    lz: [12, 3],
    modes: ['ALT HOLD', 'ASSISTED'],
    hazards: [],
    aid: false,
    snow: false,
  },
  transition: {
    height: 40,
    heading: 95 * DEG,
    pitch: -6 * DEG,
    bank: 4 * DEG,
    vel: [35 * KNOT, 1.2, 1.5],
    acc: [1.4, 0.1, 0],
    torque: 0.86,
    rpm: 0.99,
    lz: [4400, 600],
    modes: ['ALT HOLD'],
    hazards: [],
    aid: true,
    snow: false,
  },
  snow: {
    height: 4,
    heading: 180 * DEG,
    pitch: 3 * DEG,
    bank: 1 * DEG,
    vel: [-0.4, 1.3, -0.2],
    acc: [0.3, -0.6, 0.1],
    torque: 0.74,
    rpm: 1.02,
    lz: [25, 30],
    modes: ['HOVER HOLD'],
    hazards: ['ROLLOVER'],
    aid: false,
    snow: true,
  },
};

/** East, north and up at the point (0, 0, R): +X, +Y and +Z. */
function frame(c: Case) {
  const up = new Vec3d(0, 0, 1);
  const hdg = new Vec3d(Math.sin(c.heading), Math.cos(c.heading), 0);
  const right = hdg.clone().cross(up);
  const fwd = hdg.clone().scale(Math.cos(c.pitch)).addScaled(up, Math.sin(c.pitch));
  const top = up
    .clone()
    .addScaled(hdg, -Math.sin(c.pitch))
    .scale(Math.cos(c.bank))
    .addScaled(right, Math.sin(c.bank))
    .normalize();
  const local = (f: number, r: number, u: number) =>
    hdg.clone().scale(f).addScaled(right, r).addScaled(up, u);
  return { up, hdg, right, fwd, top, local };
}

/** A projector from the chase camera's eye-relative axes. */
function projector(cam: ChaseCamera, W: number, H: number): Projector {
  const f = cam.forward;
  const u = cam.up;
  const r = f.clone().cross(u).normalize();
  const view = [r.x, u.x, -f.x, 0, r.y, u.y, -f.y, 0, r.z, u.z, -f.z, 0, 0, 0, 0, 1];
  const t = 1 / Math.tan(cam.fov / 2);
  const n = 0.3;
  const fa = 1e5;
  const proj = [
    t / (W / H),
    0,
    0,
    0,
    0,
    t,
    0,
    0,
    0,
    0,
    -(fa + n) / (fa - n),
    -1,
    0,
    0,
    (-2 * fa * n) / (fa - n),
    0,
  ];
  return matrixProjector(view, proj, W, H);
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  c: Case,
  cam: ChaseCamera,
  pos: Vec3d,
  project: Projector,
  W: number,
  H: number,
): void {
  const { hdg, right, fwd, top } = frame(c);
  const eye = cam.eye;
  const rel = (p: Vec3d) => project(p.x - eye.x, p.y - eye.y, p.z - eye.z, true);
  ctx.fillStyle = c.snow ? '#E9EEF2' : '#5E7044';
  ctx.fillRect(0, 0, W, H);
  // Sky above the horizon: directions along the horizontal, at the camera's azimuth ±80°.
  const az = Math.atan2(cam.forward.x, cam.forward.y);
  const hz: { x: number; y: number }[] = [];
  for (let a = -80; a <= 80; a += 5) {
    const d = az + a * DEG;
    const p = project(Math.sin(d), Math.cos(d), -0.004, false);
    if (p) hz.push(p);
  }
  if (hz.length > 1) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, c.snow ? '#C9D6E2' : '#6D9CC8');
    g.addColorStop(1, c.snow ? '#F4F6F8' : '#C7D8E4');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(hz[0]!.x, -10);
    for (const p of hz) ctx.lineTo(p.x, p.y);
    ctx.lineTo(hz[hz.length - 1]!.x, -10);
    ctx.closePath();
    ctx.fill();
  }
  // A 10 m grid on the ground, in short pieces so those behind the camera drop out.
  const g0 = new Vec3d(0, 0, R + GROUND);
  ctx.strokeStyle = c.snow ? 'rgba(120,130,140,0.5)' : 'rgba(30,40,20,0.45)';
  ctx.lineWidth = 1;
  const E = new Vec3d(1, 0, 0);
  const N = new Vec3d(0, 1, 0);
  const cx = Math.round(pos.x / 10) * 10;
  const cy = Math.round(pos.y / 10) * 10;
  for (const [a, b] of [
    [E, N],
    [N, E],
  ] as const) {
    for (let k = -200; k <= 200; k += 10) {
      ctx.beginPath();
      let pen = false;
      for (let s = -200; s <= 200; s += 4) {
        const p = rel(
          g0
            .clone()
            .addScaled(a, (a === E ? cx : cy) + s)
            .addScaled(b, (b === E ? cx : cy) + k),
        );
        if (!p) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
        pen = true;
      }
      ctx.stroke();
    }
  }
  // Shadow, fuselage and rotor disc: a block stand-in, not the model.
  const at = (o: Vec3d, f: number, r: number, u: number) =>
    o.clone().addScaled(fwd, f).addScaled(right, r).addScaled(top, u);
  const poly = (pts: Vec3d[], fill: string) => {
    const q = pts.map(rel);
    if (q.some((p) => !p)) return;
    ctx.fillStyle = fill;
    ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo(p!.x, p!.y) : ctx.moveTo(p!.x, p!.y)));
    ctx.closePath();
    ctx.fill();
  };
  const shadow = new Vec3d(pos.x, pos.y, R + GROUND + 0.05);
  poly(
    Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      return shadow
        .clone()
        .addScaled(hdg, 3.5 * Math.cos(a))
        .addScaled(right, 1.6 * Math.sin(a));
    }),
    'rgba(0,0,0,0.3)',
  );
  const box = (f0: number, f1: number, w: number, u0: number, u1: number, fill: string) => {
    const faces: [number, number, number][][] = [
      [
        [f0, -w, u1],
        [f1, -w, u1],
        [f1, w, u1],
        [f0, w, u1],
      ],
      [
        [f0, -w, u0],
        [f1, -w, u0],
        [f1, -w, u1],
        [f0, -w, u1],
      ],
      [
        [f0, w, u0],
        [f1, w, u0],
        [f1, w, u1],
        [f0, w, u1],
      ],
      [
        [f0, -w, u0],
        [f0, w, u0],
        [f0, w, u1],
        [f0, -w, u1],
      ],
    ];
    for (const face of faces)
      poly(
        face.map(([a, b, d]) => at(pos, a, b, d)),
        fill,
      );
  };
  box(-9, -2.5, 0.35, 0.2, 0.9, '#3A3F38');
  box(-2.5, 4.2, 1.1, -1.3, 1.1, '#454B42');
  const hub = at(pos, 0, 0, 1.6);
  poly(
    Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      return at(hub, ROTOR * Math.cos(a), ROTOR * Math.sin(a), 0);
    }),
    'rgba(40,44,40,0.35)',
  );
}

export async function drawHover(name: string): Promise<void> {
  const c = CASES[name] ?? CASES['hover']!;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const { top, fwd, local } = frame(c);
  const pos = new Vec3d(0, 0, R + GROUND + c.height);
  const vel = local(...c.vel);
  const acc = local(...c.acc);
  const cam = new ChaseCamera(R, helicopterRig(ROTOR));
  cam.groundAt = () => GROUND;
  cam.target.pos.copy(pos);
  cam.target.forward.copy(fwd);
  cam.target.up.copy(top);
  cam.target.velocity.copy(vel);
  cam.target.onGround = false;
  for (let i = 0; i < 300; i++) cam.update(1 / 60);
  const project = projector(cam, W, H);

  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  bg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
  document.body.appendChild(bg);
  (document.getElementById('shot') as HTMLImageElement).hidden = true;
  drawScene(bg.getContext('2d')!, c, cam, pos, project, W, H);

  const hover = hoverSymbols({
    pos,
    forward: fwd,
    eye: cam.eye,
    radius: R,
    groundHeight: GROUND,
    gearHeight: 1.2,
    velocity: vel,
    accel: acc,
    torque: c.torque,
    rotorRpm: c.rpm,
    lz: c.lz ? local(c.lz[0], c.lz[1], 0).add(new Vec3d(0, 0, R + GROUND)) : null,
    modes: c.modes,
    hazards: c.hazards,
  });
  let aid: HudLandingAid | null = null;
  if (c.aid) {
    // A runway 6 km east, seen as its outline.
    const ctr = new Vec3d(6000, 400, R + GROUND);
    const corner = (e: number, n: number): [number, number, number] => [
      ctr.x + e - cam.eye.x,
      ctr.y + n - cam.eye.y,
      ctr.z - cam.eye.z,
    ];
    aid = {
      name: 'Mirer Air Base',
      designator: '10',
      distance: 4800,
      bearing: 100 * DEG,
      localizer: 0,
      glideslope: 0,
      corners: [corner(-1350, -22), corner(1350, -22), corner(1350, 22), corner(-1350, 22)],
      aim: corner(-1050, 0),
    };
  }
  const airspeed = Math.hypot(c.vel[0], c.vel[1]);
  const f: HudFrame = {
    cas: airspeed,
    mach: airspeed / 340,
    altitude: GROUND + c.height,
    radarAltitude: hover.radarAltitude,
    verticalSpeed: hover.verticalSpeed,
    heading: c.heading,
    pitch: c.pitch,
    bank: c.bank,
    alpha: 0,
    beta: 0,
    load: 1,
    throttle: 0,
    power: 0,
    afterburner: 0,
    fuel: 980,
    unlimitedFuel: false,
    gear: 1,
    gearDown: true,
    speedbrake: 0,
    brakes: false,
    parkingBrake: false,
    onGround: false,
    velocity: [vel.x, vel.y, vel.z],
    boresight: [fwd.x, fwd.y, fwd.z],
    warnings: [],
    aid,
    mode: 'mouse stick',
    aim: null,
    debug: null,
    hover,
  };
  const hud = new Hud();
  hud.show(true);
  hud.draw(f, project);
}
