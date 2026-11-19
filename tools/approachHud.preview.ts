/**
 * HUD frames of the straight-in approach (decision 207) for tools/hud/composite.html: flies
 * tests/helpers/decel.ts's acceptance approach headlessly and, at 20, 13 and 6 km from the
 * threshold, writes tools/out/freeflight-approach-<km>.json with the HUD frame from a chase
 * camera, over a plain stand-in image (no render: the HUD's cues are what it shows). Then,
 * with `npm run dev` up: `SHOTS=approach-20,approach-13,approach-6 OUT_DIR=tools/out
 * node tools/freeflight.screens.mjs`.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/approachHud.preview.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PerspectiveCamera, Vector3 } from 'three';
import { test } from 'vitest';
import { buildHudFrame, landingAid } from '../src/ui/flight/hudFrame';
import { straightInApproach } from '../tests/helpers/decel';
import { encodePng } from './png';

const W = 1280;
const H = 720;

test('approach HUD frames', () => {
  const out = join(import.meta.dirname, 'out');
  mkdirSync(out, { recursive: true });
  const marks = [20, 13, 6];
  straightInApproach(undefined, undefined, undefined, undefined, (m, ctl, before, runway) => {
    const km = marks[0];
    if (km === undefined || before > km * 1000) return;
    marks.shift();
    const up = m.pos.clone().normalize();
    const fwd = m.vel.clone().normalize();
    const eye = m.pos.clone().addScaled(fwd, -32).addScaled(up, 7);
    const cam = new PerspectiveCamera(60, W / H, 1, 1e6);
    cam.up.set(up.x, up.y, up.z);
    const at = m.pos.clone().sub(eye).addScaled(fwd, 400);
    cam.lookAt(new Vector3(at.x, at.y, at.z));
    cam.updateMatrixWorld();
    const frame = buildHudFrame(m, ctl, {
      aid: landingAid(m, [runway], eye),
      mode: 'autopilot',
      control: null,
      timing: null,
    });
    // Stand-in sky over ground: the horizon about where the camera puts it.
    const rgb = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const sky = y < H * 0.42;
        rgb.set(sky ? [118, 150, 182] : [92, 112, 84], (y * W + x) * 3);
      }
    writeFileSync(join(out, `freeflight-approach-${km}.png`), encodePng(W, H, rgb));
    writeFileSync(
      join(out, `freeflight-approach-${km}.json`),
      JSON.stringify({
        width: W,
        height: H,
        frame,
        messages: [],
        view: Array.from(cam.matrixWorldInverse.elements),
        projection: Array.from(cam.projectionMatrix.elements),
      }),
    );
    const e = frame.aid?.energy;
    console.log(
      `${km} km: ${(m.telemetry.cas / 0.514444).toFixed(0)} KIAS, trend ${(frame.speedCues!.trend / 0.514444).toFixed(0)}, ` +
        `bug ${(frame.speedCues!.approach / 0.514444).toFixed(0)}, energy ${e ? `${e.state} ${(e.needed / 1000).toFixed(1)}/${(e.available / 1000).toFixed(1)} km` : 'none'}`,
    );
  });
});
