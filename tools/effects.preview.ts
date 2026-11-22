/**
 * The effects sandbox headless (Proposal 0011, decision 327): renders scripted scenes of
 * the stylized effects on Dawn and writes PNGs, and times the stress scene.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/effects.preview.ts
 *   env: SHOTS (all: sam,sam-20km,airburst,impact,depot,contrails,chimneys,downwash,vortex,
 *        missiles,night,stress), W × H (960 × 540), POST=0, OUT (tools/out/effects),
 *        PERF=n (frames timed in the stress scene, 20), FPS (simulation steps per second, 30)
 *
 * Each shot resets the sandbox, steps it at FPS without drawing until its time, then draws.
 * A sequence (`impact`) draws several times into a contact sheet. The stress shot draws the
 * scene with and without the effects, interleaved, and prints the medians, the puffs alive
 * and the compute dispatches. On a software adapter only ratios and counts mean anything.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { EffectsSandbox } from '../src/effectsSandbox/sandboxScene';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';

interface Shot {
  view: string;
  setup: (s: EffectsSandbox) => void;
  /** Times (s) at which to draw; several make a contact sheet. */
  at: number[];
  sun?: [number, number];
}

const SHOTS: Record<string, Shot> = {
  sam: { view: 'sam', setup: (s) => s.spawn('sam-launch'), at: [2.5] },
  'sam-20km': { view: 'sam-20km', setup: (s) => s.spawn('sam-launch'), at: [8] },
  airburst: {
    view: 'range',
    setup: (s) => {
      s.lookFrom(s.local(-160, -240, 170), s.local(0, 0, 225));
      s.effects.explode(s.local(0, 0, 230), 39, 'air');
    },
    at: [0.08, 0.5, 1.5, 5],
  },
  impact: {
    view: 'range',
    setup: (s) => s.effects.explode(s.local(0, 40, 0), 87, 'ground'),
    at: [0.06, 0.4, 1.2, 3, 8, 20],
  },
  depot: {
    view: 'depot',
    setup: (s) => {
      s.effects.spawnPreset('fuel-fire', s.site('depot'), 'depot');
      s.effects.spawnPreset(
        'burning-target',
        s.site('depot').addScaled(
          s
            .local(1, 0, 0)
            .sub(s.local(0, 0, 0))
            .normalize(),
          160,
        ),
        'depot2',
      );
    },
    at: [3],
  },
  contrails: {
    view: 'contrails',
    setup: (s) => {
      s.contrail();
      s.hardTurn(7);
    },
    at: [30],
  },
  chimneys: {
    view: 'works',
    setup: (s) => {
      s.spawn('chimney');
      s.spawn('cooling-tower');
    },
    at: [2],
  },
  downwash: { view: 'helipad', setup: (s) => s.hover(30), at: [4] },
  vortex: {
    view: 'vortex',
    setup: (s) => s.hardTurn(7),
    at: [6],
  },
  missiles: {
    view: 'overview',
    setup: (s) => {
      for (let i = 0; i < 3; i++) s.missile('solid');
      for (let i = 0; i < 2; i++) s.missile('reduced-smoke');
      s.aircraft('burning');
      s.aircraft('damaged');
      s.flares();
    },
    at: [4],
  },
  night: {
    view: 'range',
    sun: [-12, 220],
    setup: (s) => {
      s.effects.explode(s.local(0, 40, 0), 429, 'ground');
      s.effects.spawnPreset('fuel-fire', s.local(-120, 160, 0), 'night-fire');
    },
    at: [0.1, 0.6, 6],
  },
};

it('renders the effects sandbox', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const width = Number(process.env.W ?? 960);
  const height = Number(process.env.H ?? 540);
  const fps = Number(process.env.FPS ?? 30);
  const out = process.env.OUT ?? join(import.meta.dirname, 'out', 'effects');
  mkdirSync(out, { recursive: true });
  const head = await headlessRenderer(gpu.device, width, height);
  const sandbox = new EffectsSandbox(head.renderer, { post: process.env.POST !== '0' });
  sandbox.camera.aspect = width / height;
  sandbox.camera.updateProjectionMatrix();
  const names = (process.env.SHOTS ?? Object.keys(SHOTS).concat('stress').join(',')).split(',');
  for (const name of names) {
    if (name === 'stress') {
      await stress(sandbox, head, gpu, out, fps);
      continue;
    }
    const shot = SHOTS[name];
    if (!shot) throw new Error(`no shot ${name}`);
    sandbox.reset();
    sandbox.setSun(...(shot.sun ?? [35, 220]));
    sandbox.setView(shot.view);
    // A frame first: the anchor and the sky settle.
    sandbox.frame(1 / fps, false);
    shot.setup(sandbox);
    let t = 0;
    const frames: Uint8Array[] = [];
    for (const at of shot.at) {
      while (t + 1 / fps < at) {
        sandbox.frame(1 / fps, false);
        t += 1 / fps;
      }
      sandbox.frame(Math.max(1e-3, at - t), true);
      t = at;
      await gpu.finish();
      frames.push(await head.readRgb());
    }
    const s = sandbox.effects.stats;
    const file = join(out, `effects-${name}.png`);
    writeFileSync(file, sheet(frames, width, height));
    console.log(
      `${name}: ${frames.length} frame(s), ${s.live} puffs, ${s.emitters} emitters, ${s.ribbons} ribbon points → ${file}`,
    );
  }
  sandbox.dispose();
  head.dispose();
});

/** Frames side by side, wrapping after three. */
function sheet(frames: Uint8Array[], w: number, h: number): Buffer {
  const cols = Math.min(3, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const rgb = new Uint8Array(cols * w * rows * h * 3);
  frames.forEach((f, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    for (let y = 0; y < h; y++)
      rgb.set(f.subarray(y * w * 3, (y + 1) * w * 3), ((r * h + y) * cols * w + c * w) * 3);
  });
  return encodePng(cols * w, rows * h, rgb);
}

async function stress(
  sandbox: EffectsSandbox,
  head: Awaited<ReturnType<typeof headlessRenderer>>,
  gpu: NonNullable<Awaited<ReturnType<typeof testGpu>>>,
  out: string,
  fps: number,
): Promise<void> {
  sandbox.reset();
  sandbox.setSun(35, 220);
  sandbox.setView('overview');
  sandbox.frame(1 / fps, false);
  sandbox.stress();
  for (let i = 0; i < fps * 3; i++) sandbox.frame(1 / fps, false);
  const n = Number(process.env.PERF ?? 20);
  const times = { with: [] as number[], without: [] as number[], compute: [] as number[] };
  const effects = sandbox.effects;
  for (let i = 0; i < n; i++) {
    for (const on of [true, false]) {
      effects.group.visible = on;
      await gpu.finish();
      const t0 = performance.now();
      sandbox.frame(1 / fps, true);
      await gpu.finish();
      (on ? times.with : times.without).push(performance.now() - t0);
    }
    // The compute alone: a step without drawing.
    await gpu.finish();
    const t0 = performance.now();
    sandbox.frame(1 / fps, false);
    await gpu.finish();
    times.compute.push(performance.now() - t0);
  }
  effects.group.visible = true;
  sandbox.frame(1 / fps, true);
  await gpu.finish();
  writeFileSync(
    join(out, 'effects-stress.png'),
    sheet([await head.readRgb()], head.width, head.height),
  );
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const s = effects.stats;
  console.log(
    `stress: ${s.live} puffs alive (pool high water ${s.drawn}), ${s.emitters} emitters, ${s.columns} columns, ` +
      `${s.debris} debris, ${s.marks} marks, ${s.lights} lights, rate scale ${s.rateScale.toFixed(2)}, ` +
      `${s.dispatches} dispatches, overwritten ${s.overwritten}`,
  );
  console.log(
    `stress frame (ms, median of ${n}): with effects ${med(times.with).toFixed(1)}, without ${med(times.without).toFixed(1)}, ` +
      `step without drawing ${med(times.compute).toFixed(1)}`,
  );
}
